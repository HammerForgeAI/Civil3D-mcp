import { ApplicationClientConnection, Civil3DRpcError } from "./SocketClient.js";
import { createLogger } from "./logger.js";
import { currentAbortSignal } from "./requestContext.js";

const log = createLogger("ConnectionManager");

const CIVIL3D_HOST = process.env.CIVIL3D_HOST ?? "localhost";
const CIVIL3D_PORT = parseInt(process.env.CIVIL3D_PORT ?? "8080", 10);
const CONNECT_TIMEOUT_MS = parseInt(process.env.CIVIL3D_CONNECT_TIMEOUT ?? "5000", 10);

/** Names the target taken from CIVIL3D_HOST / CIVIL3D_PORT. */
export const DEFAULT_INSTANCE_LABEL = "default";
/** Names the optional target list. Format: `label=host:port,label=host:port`. */
export const INSTANCES_VARIABLE = "CIVIL3D_INSTANCES";

export interface ApplicationCommandClient {
  sendCommand(command: string, params?: unknown): Promise<any>;
}

/**
 * One Civil 3D plugin listener. `label` is the name the selection surface
 * accepts; host and port are the TCP endpoint the plugin listens on.
 */
export interface ApplicationTarget {
  label: string;
  host: string;
  port: number;
  /** True for the target read from CIVIL3D_HOST / CIVIL3D_PORT. */
  isDefault?: boolean;
}

/** One row of the instance list: the target plus what a live probe answered. */
export interface InstanceListing extends ApplicationTarget {
  /** null when the caller asked for the list without a probe. */
  connected: boolean | null;
  /** True when commands are currently routed to this target. */
  active: boolean;
  instanceId?: string;
  processId?: number;
  listenerPort?: number;
  pluginVersion?: string;
  drawingLoaded?: boolean;
  error?: string;
}

/** The target every call uses when nothing selected another one. */
export function getDefaultTarget(): ApplicationTarget {
  return { label: DEFAULT_INSTANCE_LABEL, host: CIVIL3D_HOST, port: CIVIL3D_PORT, isDefault: true };
}

/**
 * Reads CIVIL3D_INSTANCES, a comma-separated list of `label=host:port` entries
 * (for example `alpha=127.0.0.1:8080,beta=127.0.0.1:8081`). Malformed entries,
 * unusable ports and repeated labels are dropped with a warning, because a bad
 * configuration value must not stop the server from starting.
 */
export function parseInstanceTargets(raw: string | undefined = process.env[INSTANCES_VARIABLE]): ApplicationTarget[] {
  if (!raw || !raw.trim()) {
    return [];
  }

  const targets: ApplicationTarget[] = [];
  for (const entry of raw.split(",")) {
    const text = entry.trim();
    if (!text) {
      continue;
    }

    const separator = text.indexOf("=");
    const lastColon = text.lastIndexOf(":");
    if (separator <= 0 || lastColon <= separator + 1) {
      log.warn("Ignoring malformed instance entry", { entry: text, expected: "label=host:port" });
      continue;
    }

    const label = text.slice(0, separator).trim();
    const host = text.slice(separator + 1, lastColon).trim();
    const port = Number.parseInt(text.slice(lastColon + 1).trim(), 10);
    if (!label || !host || !Number.isInteger(port) || port < 1 || port > 65535) {
      log.warn("Ignoring unusable instance entry", { entry: text });
      continue;
    }

    if (targets.some((target) => target.label.toLowerCase() === label.toLowerCase())) {
      log.warn("Ignoring an instance entry with a repeated label", { label });
      continue;
    }

    targets.push({ label, host, port, isDefault: false });
  }

  return targets;
}

/** Every selectable target: the environment default first, then CIVIL3D_INSTANCES. */
export function listApplicationTargets(): ApplicationTarget[] {
  return [getDefaultTarget(), ...parseInstanceTargets()];
}

let activeTarget: ApplicationTarget | undefined;

/** The target commands go to now: the selected one, or the environment default. */
export function getActiveTarget(): ApplicationTarget {
  return activeTarget ?? getDefaultTarget();
}

export function hasSelectedTarget(): boolean {
  return activeTarget !== undefined;
}

/** Finds a configured target by its label, case-insensitively. */
export function resolveApplicationTarget(label: string): ApplicationTarget | undefined {
  const wanted = label.trim().toLowerCase();
  return listApplicationTargets().find((target) => target.label.toLowerCase() === wanted);
}

/** Routes every later default call to this target. */
export function setActiveTarget(target: ApplicationTarget): ApplicationTarget {
  activeTarget = {
    label: target.label,
    host: target.host,
    port: target.port,
    isDefault: target.isDefault ?? false,
  };
  log.info("Selected Civil 3D instance", { label: activeTarget.label, host: activeTarget.host, port: activeTarget.port });
  return activeTarget;
}

/** Goes back to the environment default. */
export function resetActiveTarget(): ApplicationTarget {
  activeTarget = undefined;
  return getDefaultTarget();
}

/** Selects a target; selecting the environment default clears the override. */
export function selectApplicationTarget(target: ApplicationTarget): ApplicationTarget {
  return target.isDefault ? resetActiveTarget() : setActiveTarget(target);
}

function isActiveTarget(target: ApplicationTarget): boolean {
  const active = getActiveTarget();
  return active.host === target.host && active.port === target.port;
}

/**
 * The configured plugin endpoint. Diagnostics and the environment preflight on
 * `civil3d_health` report it; the defaults are the documented ones.
 */
export function getPluginEndpoint(): { host: string; port: number } {
  return { host: CIVIL3D_HOST, port: CIVIL3D_PORT };
}

/**
 * Runs an operation against the Civil 3D plugin. The native transport accepts
 * exactly one JSON-RPC request per TCP connection, so every sendCommand call
 * receives its own short-lived connection. Composite domain actions may safely
 * issue several sequential commands through the client passed to operation.
 *
 * The optional target chooses the plugin instance; without it the selected
 * target (or the environment default) is used, so every existing call site
 * keeps its behaviour. The target is bound once, so a composite action cannot
 * split its commands across two instances if the selection changes mid-flight.
 */
export async function withApplicationConnection<T>(
  operation: (client: ApplicationCommandClient) => Promise<T>,
  target?: ApplicationTarget,
): Promise<T> {
  const resolved = target ?? getActiveTarget();
  const client: ApplicationCommandClient = {
    sendCommand: async (command, params = {}) => await sendSingleCommand(command, params, resolved),
  };

  return await operation(client);
}

/**
 * Asks one target whether it is alive and which plugin session answers. A
 * target that does not answer is reported, never thrown, so listing instances
 * works while most Civil 3D sessions are closed.
 */
export async function probeApplicationTarget(target: ApplicationTarget): Promise<InstanceListing> {
  const listing: InstanceListing = { ...target, connected: false, active: isActiveTarget(target) };

  try {
    const identity = await withApplicationConnection(
      async (client) => await client.sendCommand("getListenerInstance", {}),
      target,
    ) as Record<string, unknown> | null;

    listing.connected = true;
    listing.instanceId = typeof identity?.instanceId === "string" ? identity.instanceId : undefined;
    listing.processId = typeof identity?.processId === "number" ? identity.processId : undefined;
    listing.listenerPort = typeof identity?.listenerPort === "number" ? identity.listenerPort : undefined;
    listing.pluginVersion = typeof identity?.pluginVersion === "string" ? identity.pluginVersion : undefined;
  } catch (error) {
    if (error instanceof Civil3DRpcError && error.code === "CIVIL3D.METHOD_NOT_FOUND") {
      // A plugin older than the instance-reporting method still counts as a
      // live instance; ask the health endpoint it has always answered.
      try {
        const health = await withApplicationConnection(
          async (client) => await client.sendCommand("getCivil3DHealth", {}),
          target,
        ) as Record<string, unknown> | null;
        listing.connected = true;
        listing.pluginVersion = typeof health?.pluginVersion === "string" ? health.pluginVersion : undefined;
        listing.drawingLoaded = typeof health?.drawingLoaded === "boolean" ? health.drawingLoaded : undefined;
        return listing;
      } catch (healthError) {
        listing.error = healthError instanceof Error ? healthError.message : String(healthError);
        return listing;
      }
    }

    listing.error = error instanceof Error ? error.message : String(error);
  }

  return listing;
}

/**
 * Every selectable instance, with the active one and (unless probe is false)
 * whether it answered. Probing is sequential: each probe opens one connection,
 * and the plugin serializes host work anyway.
 */
export async function listInstances(probe = true): Promise<InstanceListing[]> {
  const targets = listApplicationTargets();
  if (!probe) {
    return targets.map((target) => ({ ...target, connected: null, active: isActiveTarget(target) }));
  }

  const listings: InstanceListing[] = [];
  for (const target of targets) {
    listings.push(await probeApplicationTarget(target));
  }

  return listings;
}

async function sendSingleCommand(
  command: string,
  params: unknown,
  target: ApplicationTarget,
): Promise<any> {
  const appClient = new ApplicationClientConnection(target.host, target.port);
  const signal = currentAbortSignal();
  const cancellationError = new Civil3DRpcError(
    `Civil 3D command '${command}' was cancelled by the caller.`,
    "CIVIL3D.CANCELLED",
    -32010,
  );
  const cancel = () => appClient.cancel(cancellationError);

  try {
    if (signal?.aborted) throw cancellationError;
    signal?.addEventListener("abort", cancel, { once: true });
    if (!appClient.isConnected) {
      await new Promise<void>((resolve, reject) => {
        let settled = false;

        const cleanup = () => {
          clearTimeout(timeout);
          appClient.socket.removeListener("connect", onConnect);
          appClient.socket.removeListener("error", onError);
        };

        const onConnect = () => {
          if (settled) {
            return;
          }
          settled = true;
          cleanup();
          resolve();
        };

        const onError = (error: Error) => {
          if (settled) {
            return;
          }
          settled = true;
          cleanup();
          log.error("Connection failed", {
            host: target.host,
            port: target.port,
            error: error.message,
          });
          reject(new Error(`Failed to connect to Civil 3D plugin at ${target.host}:${target.port}`));
        };

        appClient.socket.on("connect", onConnect);
        appClient.socket.on("error", onError);

        const timeout = setTimeout(() => {
          if (settled) {
            return;
          }
          settled = true;
          cleanup();
          appClient.socket.destroy();
          log.warn("Connection timed out", { host: target.host, port: target.port, timeoutMs: CONNECT_TIMEOUT_MS });
          reject(new Error(`Connection to Civil 3D plugin timed out after ${CONNECT_TIMEOUT_MS}ms`));
        }, CONNECT_TIMEOUT_MS);

        if (!appClient.connect()) {
          onError(new Error("Socket connect call failed."));
        }
      });
    }

    return await appClient.sendCommand(command, params);
  } catch (error) {
    if (signal?.aborted) throw cancellationError;
    throw error;
  } finally {
    signal?.removeEventListener("abort", cancel);
    appClient.disconnect();
  }
}
