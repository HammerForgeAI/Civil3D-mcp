import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PLUGIN_DOMAIN_DEFINITION } from "../src/tools/domains/pluginDomain.js";

const healthSchema = PLUGIN_DOMAIN_DEFINITION.actions.health.responseSchema!;
const pluginDirectory = new URL("../Civil3D-MCP-Plugin/", import.meta.url);
const pluginRuntimeSource = readFileSync(new URL("PluginRuntime.cs", pluginDirectory), "utf8");
const stageCommandSource = readFileSync(new URL("StageTelemetryCommands.cs", pluginDirectory), "utf8");
const dispatcherSource = readFileSync(new URL("CommandDispatcher.cs", pluginDirectory), "utf8");

const baseHealth = {
  connected: true,
  civil3dVersion: "24.3s",
  pluginVersion: "1.2.1.0",
  drawingLoaded: true,
  operationInProgress: true,
  currentOperation: "saveDrawing",
  queueDepth: 1,
  queueCapacity: 64,
  currentOperationStartedAtUnixMs: 1_700_000_000_000,
  currentRequestId: "42",
  currentOperationDurationMs: 1_200,
  memoryUsageMb: 512,
  logFilePath: "C:\\logs\\Civil3DMcpPlugin\\plugin.log",
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

const stageTelemetry = {
  currentStage: "host-execution",
  currentStageStartedAtUnixMs: 1_700_000_000_050,
  currentStageDurationMs: 1_150,
  currentStageState: "running",
  stallThresholdMs: 30_000,
  stages: [
    { name: "queued", startedAtUnixMs: 1_700_000_000_000, durationMs: 50, state: "completed" },
    { name: "host-execution", startedAtUnixMs: 1_700_000_000_050, durationMs: 1_150, state: "running" },
  ],
};

function readStageStates(source: string): string[] {
  const block = /internal static class StageState\s*\{([\s\S]*?)\}/.exec(source)?.[1] ?? "";
  return [...block.matchAll(/public const string \w+ = "([^"]+)";/g)].map((match) => match[1]!).sort();
}

function readStageNames(source: string): string[] {
  const block = /internal static class StageName\s*\{([\s\S]*?)\}/.exec(source)?.[1] ?? "";
  return [...block.matchAll(/public const string \w+ = "([^"]+)";/g)].map((match) => match[1]!).sort();
}

describe("civil3d_health stage telemetry", () => {
  it("preserves the per-stage timing the plugin publishes", () => {
    const response = healthSchema.parse({ ...baseHealth, stageTelemetry });

    expect(response.stageTelemetry).toEqual(stageTelemetry);
    expect(response.stageTelemetry!.currentStage).toBe("host-execution");
    expect(response.stageTelemetry!.stages.map((stage) => stage.name)).toEqual(["queued", "host-execution"]);
    expect(response.stageTelemetry!.stages[0]).toMatchObject({ state: "completed", durationMs: 50 });
    expect(response.stageTelemetry!.stallThresholdMs).toBe(30_000);
  });

  it("reports a stalled stage and an idle plugin without inventing a stage", () => {
    const stalled = healthSchema.parse({
      ...baseHealth,
      stageTelemetry: { ...stageTelemetry, currentStageState: "stalled", currentStageDurationMs: 45_000 },
    });
    expect(stalled.stageTelemetry!.currentStageState).toBe("stalled");

    const idle = healthSchema.parse({
      ...baseHealth,
      stageTelemetry: {
        currentStage: null,
        currentStageStartedAtUnixMs: null,
        currentStageDurationMs: null,
        currentStageState: null,
        stallThresholdMs: 30_000,
        stages: [],
      },
    });
    expect(idle.stageTelemetry!.currentStage).toBeNull();
    expect(idle.stageTelemetry!.stages).toEqual([]);
  });

  it("still answers health for a plugin build that publishes no stage telemetry", () => {
    const response = healthSchema.parse(baseHealth);

    expect(response.stageTelemetry).toBeUndefined();
    expect(response.queueCapacity).toBe(64);
    expect(response.currentOperationDurationMs).toBe(1_200);
  });

  it("rejects a stage verdict outside the completed/stalled contract", () => {
    expect(() => healthSchema.parse({
      ...baseHealth,
      stageTelemetry: {
        ...stageTelemetry,
        stages: [{ name: "queued", startedAtUnixMs: 0, durationMs: 5, state: "wedged" }],
      },
    })).toThrow();
  });

  it("keeps the C# stage contract aligned with the TypeScript schema", () => {
    expect(readStageStates(pluginRuntimeSource)).toEqual(["completed", "running", "stalled"]);
    expect(readStageNames(pluginRuntimeSource)).toEqual(["host-execution", "queued"]);
    expect(pluginRuntimeSource).toContain("StageStallThresholdMs");

    // getCivil3DHealth keeps its name and its arm; only the implementation it
    // points at changed, so the manifest's pluginMethods entry stays accurate.
    expect(dispatcherSource).toContain('"getCivil3DHealth" => StageTelemetryCommands.GetCivil3DHealthWithStagesAsync(),');
    expect(dispatcherSource).toContain('"getCivil3DStageTelemetry" => StageTelemetryCommands.GetStageTelemetryAsync(),');
    expect(stageCommandSource).toContain('"stageTelemetry"');
    expect(stageCommandSource).toContain("PluginRuntime.GetStageTelemetry()");
    expect(PLUGIN_DOMAIN_DEFINITION.actions.health.pluginMethods).toEqual(["getCivil3DHealth"]);
  });
});
