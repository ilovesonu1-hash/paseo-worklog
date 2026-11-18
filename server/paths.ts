import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { mkdirSync } from "node:fs";

export function resolveDataDirectory(env: Record<string, string | undefined> = process.env): string {
  const configured = env.PASEO_HOME?.trim();
  const home = configured
    ? (configured === "~" ? homedir() : configured.startsWith("~/") ? join(homedir(), configured.slice(2)) : resolve(configured))
    : join(homedir(), ".paseo");
  return join(home, "plugin-data", "worklog-board");
}

export function prepareDataDirectory(): string {
  const directory = resolveDataDirectory();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return directory;
}
