import { afterEach, describe, expect, it } from "vitest";
import * as net from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  buildEnvironmentPreflight,
  collectEnvironmentPreflight,
  observeFileRoot,
  parseRootList,
  probePort,
  probePluginRuntime,
  readPackageMetadata,
  satisfiesNodeRange,
  type PreflightProbes,
} from "../src/utils/environmentPreflight.js";
import { PLUGIN_DOMAIN_DEFINITION } from "../src/tools/domains/pluginDomain.js";

/**
 * The environment preflight is the reduced port of the donor `setup_check.py`
 * (port plan item 23). Every probe is injected, so these tests pin the verdicts
 * without reading the host environment. The only real filesystem work happens
 * in a temp directory, and the only real network work is a loopback probe.
 */

const tempDirectories: string[] = [];

function makeTempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "c3d-preflight-"));
  tempDirectories.push(directory);
  return directory;
}

afterEach(() => {
  while (tempDirectories.length > 0) {
    rmSync(tempDirectories.pop()!, { recursive: true, force: true });
  }
});

function probes(overrides: Partial<PreflightProbes> = {}): PreflightProbes {
  return {
    nodeVersion: "22.14.0",
    requiredNodeRange: ">=18.17.0",
    plugin: {
      endpoint: "localhost:8080",
      port: "occupied",
      load: "loaded",
      pluginVersion: "1.2.1.0",
    },
    fileRoots: [
      { source: "CIVIL3D_IMPORT_ROOTS", path: "C:\\Proj\\src", state: "directory-writable" },
      { source: "CIVIL3D_EXPORT_ROOTS", path: "C:\\Proj\\out", state: "directory-writable" },
    ],
    optionalDependencies: [
      { id: "docker", label: "Docker CLI", purpose: "container deployment", present: true, location: "C:\\docker.exe" },
      { id: "mcpb", label: "@anthropic-ai/mcpb", purpose: "packaging", present: true, location: "C:\\mcpb" },
    ],
    ...overrides,
  };
}

function checkFor(report: ReturnType<typeof buildEnvironmentPreflight>, id: string) {
  const check = report.checks.find((entry) => entry.id === id);
  expect(check, `expected a check with id '${id}'`).toBeDefined();
  return check!;
}

describe("environment preflight", () => {
  it("reports a good environment as ok and names every value it saw", () => {
    const report = buildEnvironmentPreflight(probes());

    expect(report.status).toBe("ok");
    expect(report.summary).toEqual({ ok: 7, warn: 0, fail: 0 });

    const node = checkFor(report, "node-version");
    expect(node.status).toBe("ok");
    expect(node.value).toBe("v22.14.0 (required >=18.17.0)");

    const port = checkFor(report, "plugin-port");
    expect(port.status).toBe("ok");
    expect(port.value).toBe("localhost:8080 is occupied");

    const load = checkFor(report, "plugin-load");
    expect(load.status).toBe("ok");
    expect(load.value).toBe("loaded (plugin version 1.2.1.0)");

    for (const root of ["CIVIL3D_IMPORT_ROOTS", "CIVIL3D_EXPORT_ROOTS"]) {
      const check = checkFor(report, `file-root:${root}:${probes().fileRoots.find((entry) => entry.source === root)!.path}`);
      expect(check.status).toBe("ok");
    }
  });

  it("fails a missing file root and keeps the path it looked at", () => {
    const report = buildEnvironmentPreflight(probes({
      fileRoots: [
        { source: "CIVIL3D_IMPORT_ROOTS", path: "C:\\Proj\\src", state: "directory-writable" },
        { source: "CIVIL3D_IMPORT_ROOTS", path: "C:\\Proj\\gone", state: "missing" },
      ],
    }));

    expect(report.status).toBe("fail");
    expect(report.summary.fail).toBe(1);

    const missing = checkFor(report, "file-root:CIVIL3D_IMPORT_ROOTS:C:\\Proj\\gone");
    expect(missing.status).toBe("fail");
    expect(missing.value).toBe("C:\\Proj\\gone (missing)");
    expect(missing.detail).toMatch(/Create the folder or fix the variable/);
  });

  it("fails a bad Node version against the required range", () => {
    const report = buildEnvironmentPreflight(probes({ nodeVersion: "16.20.2" }));

    expect(report.status).toBe("fail");
    const node = checkFor(report, "node-version");
    expect(node.status).toBe("fail");
    expect(node.value).toBe("v16.20.2 (required >=18.17.0)");
    expect(node.detail).toMatch(/Install Node >=18\.17\.0/);
  });

  it("fails a read-only root and warns when a root could not be inspected", () => {
    const report = buildEnvironmentPreflight(probes({
      fileRoots: [
        { source: "CIVIL3D_EXPORT_ROOTS", path: "C:\\Proj\\out", state: "directory-read-only" },
        { source: "CIVIL3D_EXPORT_ROOTS", path: "\\\\share\\out", state: "unknown", error: "EIO: i/o error" },
      ],
    }));

    expect(report.status).toBe("fail");
    expect(checkFor(report, "file-root:CIVIL3D_EXPORT_ROOTS:C:\\Proj\\out").status).toBe("fail");

    const unknown = checkFor(report, "file-root:CIVIL3D_EXPORT_ROOTS:\\\\share\\out");
    expect(unknown.status).toBe("warn");
    expect(unknown.detail).toMatch(/EIO: i\/o error/);
  });

  it("reports an unreachable plugin and a free port as failures", () => {
    const report = buildEnvironmentPreflight(probes({
      plugin: { endpoint: "localhost:8080", port: "free", load: "unreachable", error: "Failed to connect to Civil 3D plugin at localhost:8080" },
    }));

    expect(report.status).toBe("fail");
    const port = checkFor(report, "plugin-port");
    expect(port.status).toBe("fail");
    expect(port.value).toBe("localhost:8080 is free");

    const load = checkFor(report, "plugin-load");
    expect(load.status).toBe("fail");
    expect(load.value).toContain("Failed to connect to Civil 3D plugin at localhost:8080");
  });

  it("stays advisory when an optional dependency is absent", () => {
    const report = buildEnvironmentPreflight(probes({
      optionalDependencies: [
        { id: "docker", label: "Docker CLI", purpose: "container deployment", present: false },
      ],
    }));

    expect(report.status).toBe("warn");
    const docker = checkFor(report, "optional-dependency:docker");
    expect(docker.status).toBe("warn");
    expect(docker.value).toBe("not installed (container deployment)");
  });

  it("accepts the plugin's own Documents fallback when no root is configured", () => {
    const report = buildEnvironmentPreflight(probes({ fileRoots: [] }));

    expect(report.status).toBe("ok");
    const roots = checkFor(report, "file-roots");
    expect(roots.status).toBe("ok");
    expect(roots.value).toContain("Documents folder");
  });

  it("warns instead of guessing when engines.node cannot be compared", () => {
    expect(satisfiesNodeRange("22.14.0", "latest")).toBeNull();
    expect(satisfiesNodeRange("22.14.0", ">=18.17.0")).toBe(true);
    expect(satisfiesNodeRange("18.17.0", ">=18.17.0")).toBe(true);
    expect(satisfiesNodeRange("18.16.9", ">=18.17.0")).toBe(false);
    expect(satisfiesNodeRange("24.0.0", ">=18.17.0 <25.0.0")).toBe(true);
    expect(satisfiesNodeRange("25.0.0", ">=18.17.0 <25.0.0")).toBe(false);

    const declaredNone = buildEnvironmentPreflight(probes({ requiredNodeRange: null }));
    expect(checkFor(declaredNone, "node-version").status).toBe("warn");
  });
});

describe("environment probes", () => {
  it("reads the required Node range from package.json", () => {
    const metadata = readPackageMetadata();
    expect(typeof metadata.enginesNode).toBe("string");
    expect(metadata.enginesNode!.length).toBeGreaterThan(0);
    expect(satisfiesNodeRange(process.versions.node, metadata.enginesNode!)).toBe(true);
  });

  it("splits configured roots the way the plugin's FileBoundary does", () => {
    expect(parseRootList(undefined)).toEqual([]);
    expect(parseRootList("   ")).toEqual([]);
    const first = join("root", "a");
    const second = join("root", "b");
    expect(parseRootList(` ${[first, second].join(delimiter)} `)).toEqual([first, second]);
  });

  it("observes a writable temp directory, a missing folder and a file", () => {
    const directory = makeTempDirectory();
    writeFileSync(join(directory, "note.txt"), "x");

    expect(observeFileRoot("CIVIL3D_FILE_ROOTS", directory).state).toBe("directory-writable");
    expect(observeFileRoot("CIVIL3D_FILE_ROOTS", join(directory, "gone")).state).toBe("missing");
    expect(observeFileRoot("CIVIL3D_FILE_ROOTS", join(directory, "note.txt")).state).toBe("not-a-directory");
  });

  it("reports the plugin load state from the health handshake", async () => {
    const loaded = await probePluginRuntime({
      sendCommand: async () => ({ connected: true, pluginVersion: "1.2.1.0" }),
    });
    expect(loaded.load).toBe("loaded");
    expect(loaded.pluginVersion).toBe("1.2.1.0");
    expect(loaded.payload).toMatchObject({ connected: true });

    const failure = new Error("Failed to connect to Civil 3D plugin at localhost:8080");
    const unreachable = await probePluginRuntime({
      sendCommand: async () => {
        throw failure;
      },
    });
    expect(unreachable.load).toBe("unreachable");
    expect(unreachable.payload).toBeNull();
    expect(unreachable.error).toBe(failure);

    const malformed = await probePluginRuntime({ sendCommand: async () => "not an object" });
    expect(malformed.load).toBe("unreachable");
  });

  it("probes the plugin port over real loopback sockets", async () => {
    const server = net.createServer((socket) => socket.end());
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });

    try {
      const address = server.address() as net.AddressInfo;
      expect(await probePort("127.0.0.1", address.port)).toBe("occupied");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    const closed = await new Promise<number>((resolve, reject) => {
      const probe = net.createServer();
      probe.once("error", reject);
      probe.listen(0, "127.0.0.1", () => {
        const port = (probe.address() as net.AddressInfo).port;
        probe.close(() => resolve(port));
      });
    });
    expect(await probePort("127.0.0.1", closed)).toBe("free");
  });

  it("collects a report from the running process without inventing checks", () => {
    const report = collectEnvironmentPreflight({
      endpoint: "localhost:8080",
      port: "occupied",
      load: "loaded",
      pluginVersion: "1.2.1.0",
    });

    expect(checkFor(report, "node-version").status).toBe("ok");
    expect(report.checks.some((check) => check.id === "plugin-load")).toBe(true);
    expect(report.checks.some((check) => check.id.startsWith("optional-dependency:"))).toBe(true);
  });

  it("keeps the published health payload additive", () => {
    const report = buildEnvironmentPreflight(probes());
    const pluginHealth = {
      connected: true,
      civil3dVersion: "24.3s",
      pluginVersion: "1.2.1.0",
      drawingLoaded: true,
      operationInProgress: false,
      currentOperation: null,
      queueDepth: 0,
      queueCapacity: 64,
      currentOperationStartedAtUnixMs: null,
      currentRequestId: null,
      currentOperationDurationMs: null,
      memoryUsageMb: 512,
      logFilePath: "C:\\logs\\plugin.log",
      fileLoggingHealthy: true,
      fileLoggingError: null,
      jobs: {
        total: 1,
        running: 0,
        completed: 1,
        failed: 0,
        cancelled: 0,
        capacity: 256,
        terminalRetentionMinutes: 1440,
      },
    };

    const schema = PLUGIN_DOMAIN_DEFINITION.actions.health.responseSchema!;
    const withoutPreflight = schema.parse(pluginHealth) as { environment?: unknown };
    expect(withoutPreflight.environment).toBeUndefined();

    const withPreflight = schema.parse({ ...pluginHealth, environment: report }) as {
      environment: { status: string; checks: unknown[] };
    };
    expect(withPreflight.environment.status).toBe("ok");
    expect(withPreflight.environment.checks.length).toBe(report.checks.length);
  });
});
