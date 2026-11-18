import type { PluginServerContext } from "@getpaseo/plugin/server";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { readBoardRpc, mutateRpc, observeSessionsRpc, activitiesRpc, exportRpc } from "./shared/contracts.ts";
import { WorklogStore } from "./server/store.ts";
import { prepareDataDirectory } from "./server/paths.ts";
import { createWorklogTools } from "./server/agent-tools.ts";
import { WorkerStore } from "./server/worker-store.ts";
import { createPaseoTransport } from "./server/paseo-transport.ts";
import { WorklogRuntime } from "./server/runtime.ts";
import { configureRuntimeRpc, dismissDeliveryRpc, exchangeRpc, readRosterRpc, refreshRuntimeRpc, runtimeStatusRpc } from "./shared/sync.ts";
import { applyUpdateRpc, checkUpdateRpc, updateStatusRpc } from "./shared/updates.ts";
import { PluginUpdater } from "./server/updates.ts";

export default function contribute(server: PluginServerContext) {
  const dataDirectory = prepareDataDirectory();
  const store = new WorklogStore(join(dataDirectory, "worklog.sqlite"));
  const worker = new WorkerStore(join(dataDirectory, "worker-outbox.sqlite"));
  const transport = createPaseoTransport();
  const runtime = new WorklogRuntime(store, worker, transport);
  // Separate from the collection cycle: a GitHub or network failure never sets runtime.error.
  const updater = new PluginUpdater({ local: () => transport.local(), statePath: join(dataDirectory, "update-state.json") });
  const requireCentral = () => {
    if (worker.readConfig().config.role !== "central") throw new Error("이 호스트는 수집·보고 역할입니다. 작업 편집은 중앙 보드에서 하세요.");
  };
  server.handle(readBoardRpc, () => { requireCentral(); return store.readBoard(); });
  server.handle(mutateRpc, (input) => {
    requireCentral();
    const result = store.mutate(input);
    if (result.ok) runtime.refresh();
    return result;
  });
  server.handle(observeSessionsRpc, () => {
    throw new Error("Worklog 0.2부터는 서버가 세션을 수집합니다. 최신 Worklog 화면을 다시 열어 주세요.");
  });
  server.handle(activitiesRpc, (input) => { requireCentral(); return store.listActivities(input); });
  server.handle(readRosterRpc, () => { requireCentral(); return store.readRoster(worker.readConfig().config.pollIntervalSeconds * 3000); });
  server.handle(runtimeStatusRpc, () => runtime.status());
  server.handle(configureRuntimeRpc, ({ expectedRevision, config }) => runtime.configure(expectedRevision, config));
  server.handle(refreshRuntimeRpc, () => runtime.refresh());
  server.handle(updateStatusRpc, () => updater.status());
  server.handle(checkUpdateRpc, () => updater.check());
  server.handle(applyUpdateRpc, ({ targetRevision }) => {
    if (worker.readConfig().config.role !== "central") throw new Error("Worklog 업데이트는 중앙 보드에서만 실행합니다.");
    return updater.apply(targetRevision);
  });
  server.handle(dismissDeliveryRpc, ({ deliveryId }) => worker.dismiss(deliveryId));
  server.handle(exchangeRpc, async (input, { paseo }) => {
    const { self } = await paseo.hosts.list();
    return worker.exchange(input, self.serverId);
  });
  server.handle(exportRpc, ({ format }) => {
    requireCentral();
    const directory = join(dataDirectory, "exports");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const extension = format === "json" ? "json" : "md";
    const path = join(directory, `worklog-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}.${extension}`);
    const text = format === "json" ? store.exportJson() : store.exportMarkdown();
    writeFileSync(path, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
    return { path, text };
  });
  const tools = createWorklogTools(store, { worker, changed: () => { runtime.refresh(); } });
  const removeHook = server.addHook("agent.open.before", async ({ request }) => {
    if (request.purpose === "history") return;
    return { ...request, tools: [...request.tools, ...tools] };
  });
  runtime.start();
  updater.start();
  return async () => {
    removeHook();
    // Before the transport closes, so a lost apply response is left for the next instance.
    updater.stop();
    try { await runtime.stop(); }
    finally { worker.close(); store.close(); }
  };
}
