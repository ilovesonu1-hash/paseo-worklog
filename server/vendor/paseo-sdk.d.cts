import type { PluginHandlerContext } from "@getpaseo/plugin/server";

type PaseoApi = PluginHandlerContext["paseo"];
interface ClientConfig {
  url?: string;
  clientId: string;
  clientType?: "cli";
  appVersion?: string;
  localCredential?: () => string | undefined | Promise<string | undefined>;
  connectTimeoutMs?: number;
  reconnect?: { enabled?: boolean };
  transportFactory?: unknown;
  logger?: {
    debug(object: object, message?: string): void;
    info(object: object, message?: string): void;
    warn(object: object, message?: string): void;
    error(object: object, message?: string): void;
  };
}
declare class NativeDaemonClient {
  constructor(config: ClientConfig);
  readonly isConnected: boolean;
  connect(): Promise<void>;
  close(): Promise<void>;
  setReconnectEnabled(enabled: boolean): void;
  requireConnectedHosts(): void;
  getLastServerInfoMessage(): { serverId: string; hostname?: string | null } | null;
  invokePluginRpc(pluginId: string, method: string, input: unknown): Promise<unknown>;
  /** Throws "Update the host to review plugin updates." unless server_info.features.pluginSourceUpdates. */
  previewPluginUpdates(options?: { pluginId?: string }): Promise<unknown>;
  applyPluginUpdates(proposals: unknown[]): Promise<unknown>;
}
declare const sdk: {
  createHostClient(connection: string, config: ClientConfig): NativeDaemonClient;
  createHostChannelTransport(origin: NativeDaemonClient, serverId: string, scopeId: string, initialRouteId: string | null): unknown;
  createPaseoApi(client: NativeDaemonClient): PaseoApi;
  DaemonClient: typeof NativeDaemonClient;
};
export = sdk;
