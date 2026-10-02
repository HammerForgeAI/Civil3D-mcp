import { afterEach, describe, expect, it, vi } from "vitest";
import * as net from "node:net";
import type * as ConnectionManager from "../src/utils/ConnectionManager.js";

type JsonRpcReply =
  | { result: unknown }
  | { error: { code: number; message: string; data: { code: string } } };

interface FakeListener {
  port: number;
  methods: string[];
  close(): Promise<void>;
}

/** A stand-in for the plugin's one-request-per-connection TCP listener. */
async function startListener(handle: (method: string) => JsonRpcReply): Promise<FakeListener> {
  const methods: string[] = [];
  const server = net.createServer((socket) => {
    socket.once("data", (data) => {
      const request = JSON.parse(data.toString()) as { id: string; method: string };
      methods.push(request.method);
      const reply = handle(request.method);
      const envelope = "result" in reply
        ? { jsonrpc: "2.0", id: request.id, result: reply.result }
        : { jsonrpc: "2.0", id: request.id, error: reply.error };
      socket.end(JSON.stringify(envelope));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address() as net.AddressInfo;
  return {
    port: address.port,
    methods,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

const openListeners: FakeListener[] = [];

async function listener(handle: (method: string) => JsonRpcReply): Promise<FakeListener> {
  const created = await startListener(handle);
  openListeners.push(created);
  return created;
}

/** Always answers the listener-identity probe. */
function identityListener(instanceId: string): Promise<FakeListener> {
  return listener((method) => method === "getListenerInstance"
    ? { result: { instanceId, processId: 4242, listenerPort: 8080, pluginVersion: "test" } }
    : { error: { code: -32601, message: `no ${method}`, data: { code: "CIVIL3D.METHOD_NOT_FOUND" } } });
}

async function loadManager(env: Record<string, string> = {}): Promise<typeof ConnectionManager> {
  vi.stubEnv("CIVIL3D_HOST", env.CIVIL3D_HOST ?? "127.0.0.1");
  vi.stubEnv("CIVIL3D_PORT", env.CIVIL3D_PORT ?? "1");
  vi.stubEnv("CIVIL3D_INSTANCES", env.CIVIL3D_INSTANCES ?? "");
  vi.resetModules();
  return await import("../src/utils/ConnectionManager.js");
}

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.resetModules();
  while (openListeners.length > 0) {
    await openListeners.pop()!.close();
  }
});

describe("connection manager instance selection", () => {
  it("keeps the environment target as the default when nothing is selected", async () => {
    const manager = await loadManager({ CIVIL3D_HOST: "127.0.0.1", CIVIL3D_PORT: "6553" });

    expect(manager.getActiveTarget()).toEqual({
      label: "default",
      host: "127.0.0.1",
      port: 6553,
      isDefault: true,
    });
    expect(manager.hasSelectedTarget()).toBe(false);
    expect(manager.listApplicationTargets()).toHaveLength(1);
  });

  it("parses CIVIL3D_INSTANCES and drops malformed, out-of-range and repeated entries", async () => {
    const manager = await loadManager();

    expect(manager.parseInstanceTargets(
      "alpha=127.0.0.1:8080, beta=10.0.0.5:9000 ,broken,gamma=host,delta=127.0.0.1:99999,ALPHA=127.0.0.1:1,",
    )).toEqual([
      { label: "alpha", host: "127.0.0.1", port: 8080, isDefault: false },
      { label: "beta", host: "10.0.0.5", port: 9000, isDefault: false },
    ]);
    expect(manager.parseInstanceTargets("")).toEqual([]);
    expect(manager.parseInstanceTargets(undefined)).toEqual([]);
  });

  it("sends an explicit target's command to that instance only", async () => {
    const first = await identityListener("first");
    const second = await identityListener("second");
    const manager = await loadManager();

    const answer = await manager.withApplicationConnection(
      async (client) => await client.sendCommand("getListenerInstance", {}),
      { label: "second", host: "127.0.0.1", port: second.port },
    );

    expect((answer as { instanceId: string }).instanceId).toBe("second");
    expect(second.methods).toEqual(["getListenerInstance"]);
    expect(first.methods).toEqual([]);
  });

  it("routes default calls to the selected instance and back to the environment default", async () => {
    const fallback = await identityListener("fallback");
    const beta = await identityListener("beta");
    const manager = await loadManager({
      CIVIL3D_PORT: String(fallback.port),
      CIVIL3D_INSTANCES: `beta=127.0.0.1:${beta.port}`,
    });

    const call = async () => (await manager.withApplicationConnection(
      async (client) => await client.sendCommand("getListenerInstance", {}),
    ) as { instanceId: string }).instanceId;

    expect(await call()).toBe("fallback");
    expect(manager.hasSelectedTarget()).toBe(false);

    const selected = manager.selectApplicationTarget(manager.resolveApplicationTarget("beta")!);
    expect(selected.label).toBe("beta");
    expect(manager.hasSelectedTarget()).toBe(true);
    expect(await call()).toBe("beta");

    expect(manager.resolveApplicationTarget("BETA")?.label).toBe("beta");
    expect(manager.resolveApplicationTarget("missing")).toBeUndefined();

    // Selecting the environment default clears the override again.
    manager.selectApplicationTarget(manager.getDefaultTarget());
    expect(manager.hasSelectedTarget()).toBe(false);
    expect(await call()).toBe("fallback");

    manager.setActiveTarget({ label: "beta", host: "127.0.0.1", port: beta.port });
    expect(manager.getActiveTarget().label).toBe("beta");
    manager.resetActiveTarget();
    expect(manager.hasSelectedTarget()).toBe(false);
    expect(await call()).toBe("fallback");
  });

  it("binds the target once, so a composite action cannot switch instance mid-flight", async () => {
    const first = await identityListener("first");
    const second = await identityListener("second");
    const manager = await loadManager({ CIVIL3D_PORT: String(first.port) });

    const answers = await manager.withApplicationConnection(async (client) => {
      const one = await client.sendCommand("getListenerInstance", {}) as { instanceId: string };
      manager.setActiveTarget({ label: "second", host: "127.0.0.1", port: second.port });
      const two = await client.sendCommand("getListenerInstance", {}) as { instanceId: string };
      return [one.instanceId, two.instanceId];
    });

    expect(answers).toEqual(["first", "first"]);
    expect(second.methods).toEqual([]);
  });

  it("probes a live listener and reports the plugin instance id", async () => {
    const live = await identityListener("instance-42");
    const manager = await loadManager();

    const listing = await manager.probeApplicationTarget({ label: "alpha", host: "127.0.0.1", port: live.port });

    expect(listing).toMatchObject({
      label: "alpha",
      host: "127.0.0.1",
      port: live.port,
      connected: true,
      active: false,
      instanceId: "instance-42",
      processId: 4242,
      listenerPort: 8080,
      pluginVersion: "test",
    });
  });

  it("falls back to the health endpoint when the plugin has no instance-reporting method", async () => {
    const older = await listener((method) => method === "getCivil3DHealth"
      ? { result: { drawingLoaded: true, pluginVersion: "1.2.1" } }
      : { error: { code: -32601, message: `no ${method}`, data: { code: "CIVIL3D.METHOD_NOT_FOUND" } } });
    const manager = await loadManager();

    const listing = await manager.probeApplicationTarget({ label: "older", host: "127.0.0.1", port: older.port });

    expect(listing.connected).toBe(true);
    expect(listing.instanceId).toBeUndefined();
    expect(listing.pluginVersion).toBe("1.2.1");
    expect(listing.drawingLoaded).toBe(true);
    expect(older.methods).toEqual(["getListenerInstance", "getCivil3DHealth"]);
  });

  it("reports an unreachable instance instead of throwing", async () => {
    const dead = await identityListener("gone");
    const deadPort = dead.port;
    await dead.close();
    openListeners.splice(openListeners.indexOf(dead), 1);

    const manager = await loadManager();
    const listing = await manager.probeApplicationTarget({ label: "gone", host: "127.0.0.1", port: deadPort });

    expect(listing.connected).toBe(false);
    expect(listing.error).toContain("Failed to connect");
  });

  it("lists every configured instance without probing when asked", async () => {
    const live = await identityListener("live");
    const manager = await loadManager({
      CIVIL3D_PORT: String(live.port),
      CIVIL3D_INSTANCES: `alpha=127.0.0.1:${live.port}`,
    });

    const listings = await manager.listInstances(false);

    expect(listings.map((item) => item.label)).toEqual(["default", "alpha"]);
    expect(listings.map((item) => item.connected)).toEqual([null, null]);
    expect(listings.every((item) => item.active)).toBe(true);
    expect(live.methods).toEqual([]);
  });
});
