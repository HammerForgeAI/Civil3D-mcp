import { z } from "zod";
import { withApplicationConnection } from "../../utils/ConnectionManager.js";
import type { DomainToolDefinition } from "../domainRuntime.js";

const HealthResponseSchema = z.object({
  connected: z.boolean(),
  civil3dVersion: z.string().optional(),
  pluginVersion: z.string().optional(),
  drawingLoaded: z.boolean(),
  operationInProgress: z.boolean(),
  currentOperation: z.string().nullable(),
  queueDepth: z.number(),
  queueCapacity: z.number(),
  currentOperationStartedAtUnixMs: z.number().nullable(),
  currentRequestId: z.string().nullable(),
  currentOperationDurationMs: z.number().nullable(),
  memoryUsageMb: z.number(),
  logFilePath: z.string(),
  fileLoggingHealthy: z.boolean(),
  fileLoggingError: z.string().nullable(),
  // Item 29 (P8): per-stage timing the queue/job fields above do not carry.
  // Optional so a plugin build without stage telemetry still answers health.
  stageTelemetry: z.object({
    currentStage: z.string().nullable(),
    currentStageStartedAtUnixMs: z.number().nullable(),
    currentStageDurationMs: z.number().nullable(),
    currentStageState: z.enum(["running", "completed", "stalled"]).nullable(),
    stallThresholdMs: z.number(),
    stages: z.array(z.object({
      name: z.string(),
      startedAtUnixMs: z.number(),
      durationMs: z.number(),
      state: z.enum(["running", "completed", "stalled"]),
    })),
  }).optional(),
  jobs: z.object({
    total: z.number(),
    running: z.number(),
    completed: z.number(),
    failed: z.number(),
    cancelled: z.number(),
    capacity: z.number(),
    terminalRetentionMinutes: z.number(),
  }),
});

export const PLUGIN_DOMAIN_DEFINITION: DomainToolDefinition = {
  domain: "plugin",
  actions: {
    health: {
      action: "health",
      inputSchema: z.object({ action: z.literal("health") }),
      responseSchema: HealthResponseSchema,
      capabilities: ["query", "inspect"],
      requiresActiveDrawing: false,
      safeForRetry: true,
      pluginMethods: ["getCivil3DHealth"],
      execute: async () => await withApplicationConnection(
        async (appClient) => await appClient.sendCommand("getCivil3DHealth", {}),
      ),
    },
  },
  exposures: [
    {
      toolName: "civil3d_health",
      displayName: "Civil 3D Health",
      description: "Reports the status of the Civil 3D connection and plugin.",
      inputShape: {},
      supportedActions: ["health"],
      resolveAction: () => ({ action: "health", args: { action: "health" } }),
    },
  ],
};
