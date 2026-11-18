import { defineAgentTool } from "@getpaseo/plugin/server";
import { z } from "zod";
import { reportSchema } from "../shared/model.ts";
import type { WorklogStore } from "./store.ts";
import type { WorkerStore } from "./worker-store.ts";

/** Reporting tools are scoped to the calling agent's explicit task link. */
export function createWorklogTools(store: WorklogStore, options: { worker?: WorkerStore; changed?: () => void } = {}) {
  const getTask = defineAgentTool({
    name: "worklog_get_my_task",
    title: "Read my Worklog task",
    description: "Read the Worklog task explicitly linked to this session. Before working or reporting progress, read its current revision, doneText and nextAction. Only this session's linked task is returned. If none is linked, ask the user to link the session from Worklog's session inbox; do not invent a task ID. Worklog keeps task status separate from turn completion.",
    input: z.object({}),
    async execute(_input, { agent, paseo }) {
      const { self } = await paseo.hosts.list();
      const config = options.worker?.readConfig().config;
      const satellite = config?.role === "satellite";
      const cached = satellite ? options.worker!.getLinkedTask(self.serverId, agent.id) : null;
      const task = satellite ? cached!.task : store.getLinkedTask(self.serverId, agent.id);
      const workerState = satellite ? options.worker!.state() : null;
      const deliveries = workerState?.workerHostId === self.serverId ? workerState.deliveries
        .filter((item) => item.agentId === agent.id).slice(0, 10).map((item) => ({
          requestId: item.report.requestId, taskId: item.report.taskId, delivery: item.state,
          message: item.result && !item.result.ok ? item.result.message : null,
          dismissedAt: item.dismissedAt,
        })) : [];
      const result = task
        ? { task, source: satellite ? "central_cache" : "central", cachedAt: cached?.cachedAt ?? null,
          stale: satellite && (!cached?.cachedAt || Date.now() - Date.parse(cached.cachedAt) > config!.pollIntervalSeconds * 3000),
          deliveries,
          reportInstructions: "Use worklog_report after meaningful milestones. Include what actually ran, produced results, remaining gaps and the next action. Use the current task revision and a unique requestId; retry an uncertain response with identical arguments. An agent's done request goes to review, not verified completion. On a satellite, queued means durably saved locally and NOT yet applied to the central board. Do not claim delivery until applied. Cached revisions may be stale; never invent a newer revision. Review blocked delivery errors and reread before making a new report." }
        : { task: null, source: satellite ? "central_cache" : "central", cachedAt: cached?.cachedAt ?? null, deliveries,
          message: satellite ? "중앙에서 받은 작업 중 이 세션에 연결된 작업이 없습니다. 중앙 보드에서 이 세션을 작업에 연결한 뒤 연결 상태를 확인하세요." : "이 세션에 연결된 작업이 없습니다. Worklog의 세션 인박스에서 작업을 등록하거나 기존 작업에 연결하세요." };
      return { text: JSON.stringify(result), structuredContent: result };
    },
  });
  const report = defineAgentTool({
    name: "worklog_report",
    title: "Record work and next action",
    description: "Save a progress report on this session's linked Worklog task. Read worklog_get_my_task first for taskId and expectedRevision. summary=current position, doneText=work actually performed, nextAction=next step. These three fields replace the previous report. evidence=real output paths/check results and known gaps. Omit evidence or blockedReason to preserve the current value; an explicit empty string clears it. Evidence is an agent report, not verified by Worklog. A requested done status becomes review. On conflict reread before revising. For timeout retries preserve the SAME requestId and arguments. Reports and retries require the session to remain linked to an active task. On a satellite the response distinguishes queued, applied and blocked. Queued means only saved locally; the central daemon will collect it and may reject a stale revision. Do not describe queued reports as delivered or completed.",
    input: reportSchema,
    async execute(input, { agent, paseo }) {
      const { self } = await paseo.hosts.list();
      if (options.worker?.readConfig().config.role === "satellite") {
        const result = options.worker.enqueue(self.serverId, agent.id, input);
        return { text: JSON.stringify(result), structuredContent: result, isError: result.delivery === "blocked" };
      }
      const result = store.report(self.serverId, agent.id, input);
      if (result.ok) options.changed?.();
      return { text: JSON.stringify(result), structuredContent: result, isError: !result.ok };
    },
  });
  return [getTask, report];
}
