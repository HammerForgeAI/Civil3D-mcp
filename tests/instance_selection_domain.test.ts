import { afterEach, describe, expect, it, vi } from "vitest";
import * as net from "node:net";
import {
  getActiveTarget,
  resetActiveTarget,
  withApplicationConnection,
} from "../src/utils/ConnectionManager.js";
import { captureDomainToolHandlers } from "../src/tools/domainRuntime.js";
import { getToolHandler } from "../src/tools/toolHandlerRegistry.js";
import { DRAWING_RUNTIME_DOMAIN_DEFINITION } from "../src/tools/domains/drawingRuntimeDomain.js";

captureDomainToolHandlers(DRAWING_RUNTIME_DOMAIN_DEFINITION);

interface FakeListener {
  port: number;
  methods: string[];
  close(): Promise<void>;
}

const openListeners: FakeListener[] = [];

/** A stand-in for the plugin's one-request-per-connection TCP listener. */
async function startListener(instanceId: string): Promise<FakeListener> {
  const methods: string[] = [];
  const server = net.createServer((socket) => {
    socket.once("data", (data) => {
      const request = JSON.parse(data.toString()) as { id: string; method: string };
      methods.push(request.method);
      socket.end(JSON.stringify({
        jsonrpc: "2.0",
        id: request.id,
        result: request.method === "getListenerInstance"
          ? { instanceId, processId: 7, listenerPort: 8080, pluginVersion: "test" }
          : { method: request.method },
      }));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address() as net.AddressInfo;
  const created: FakeListener = {
    port: address.port,
    methods,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
  openListeners.push(created);
  return created;
}

async function callDrawing(rawArgs: Record<string, unknown>) {
  const handler = getToolHandler("civil3d_drawing");
  expect(handler, "civil3d_drawing handler is captured").toBeDefined();
  return await handler!(rawArgs, {});
}

function resultText(result: { content?: Array<{ text?: string }> }): string {
  return result.content?.map((item) => item.text ?? "").join("\n") ?? "";
}

// select_instance is approval-gated; these tests exercise the command itself,
// so approvals are off. The gate itself is asserted in escape_hatch_domain.
afterEach(async () => {
  vi.unstubAllEnvs();
  resetActiveTarget();
  while (openListeners.length > 0) {
    await openListeners.pop()!.close();
  }
});

describe("civil3d_drawing instance selection", () => {
  it("refuses an unknown instance label", async () => {
    vi.stubEnv("CIVIL3D_APPROVAL_MODE", "disabled");

    const result = await callDrawing({ action: "select_instance", instance: "nope" });

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("Unknown Civil 3D instance 'nope'");
    expect(getActiveTarget().label).toBe("default");
  });

  it("refuses a host without a port", async () => {
    vi.stubEnv("CIVIL3D_APPROVAL_MODE", "disabled");

    const result = await callDrawing({ action: "select_instance", host: "127.0.0.1" });

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("needs both 'host' and 'port'");
  });

  it("selects a live instance by host and port and reports its listener identity", async () => {
    vi.stubEnv("CIVIL3D_APPROVAL_MODE", "disabled");
    const live = await startListener("selected-instance");

    const result = await callDrawing({ action: "select_instance", host: "127.0.0.1", port: live.port });
    const payload = result.structuredContent as {
      result: { active: { label: string; host: string; port: number }; connected: boolean; instanceId?: string; listenerPort?: number };
    };

    expect(result.isError).toBeUndefined();
    expect(payload.result).toMatchObject({
      active: { label: `127.0.0.1:${live.port}`, host: "127.0.0.1", port: live.port },
      connected: true,
      instanceId: "selected-instance",
      listenerPort: 8080,
    });

    const answer = await withApplicationConnection(
      async (client) => await client.sendCommand("ping", {}),
    ) as { method: string };
    expect(answer.method).toBe("ping");
    expect(live.methods).toEqual(["getListenerInstance", "ping"]);
  });

  it("leaves the active instance alone when the chosen one does not answer", async () => {
    vi.stubEnv("CIVIL3D_APPROVAL_MODE", "disabled");
    const dead = await startListener("dead-instance");
    const deadPort = dead.port;
    await dead.close();
    openListeners.splice(openListeners.indexOf(dead), 1);

    const result = await callDrawing({ action: "select_instance", host: "127.0.0.1", port: deadPort });

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("did not answer");
    expect(getActiveTarget().label).toBe("default");
  });

  it("selects a configured instance by its label", async () => {
    vi.stubEnv("CIVIL3D_APPROVAL_MODE", "disabled");
    const live = await startListener("labelled-instance");
    vi.stubEnv("CIVIL3D_INSTANCES", `alpha=127.0.0.1:${live.port}`);

    const result = await callDrawing({ action: "select_instance", instance: "alpha" });
    const payload = result.structuredContent as {
      result: { active: { label: string; port: number }; connected: boolean; instanceId?: string };
    };

    expect(result.isError).toBeUndefined();
    expect(payload.result.active).toMatchObject({ label: "alpha", port: live.port });
    expect(payload.result.connected).toBe(true);
    expect(payload.result.instanceId).toBe("labelled-instance");
    expect(getActiveTarget().label).toBe("alpha");
  });

  it("lists every configured instance and reports which ones answer", async () => {
    vi.stubEnv("CIVIL3D_APPROVAL_MODE", "disabled");
    const live = await startListener("listed-instance");
    vi.stubEnv("CIVIL3D_INSTANCES", `alpha=127.0.0.1:${live.port}`);

    const result = await callDrawing({ action: "list_instances" });
    const payload = result.structuredContent as {
      result: { active: { label: string }; instances: Array<{ label: string; connected: boolean | null; instanceId?: string }> };
    };

    expect(result.isError).toBeUndefined();
    expect(payload.result.active.label).toBe("default");
    expect(payload.result.instances.map((item) => item.label)).toEqual(["default", "alpha"]);
    expect(payload.result.instances.find((item) => item.label === "alpha")).toMatchObject({
      connected: true,
      instanceId: "listed-instance",
    });
    // The environment default is not running in this test; it is reported, not thrown.
    expect(payload.result.instances.find((item) => item.label === "default")?.connected).toBe(false);

    const withoutProbe = (await callDrawing({ action: "list_instances", probe: false })).structuredContent as {
      result: { instances: Array<{ connected: boolean | null }> };
    };
    expect(withoutProbe.result.instances.map((item) => item.connected)).toEqual([null, null]);
    expect(live.methods.filter((method) => method === "getListenerInstance")).toHaveLength(1);
  });
});
