import { z } from "zod";
import { getPluginEndpoint, withApplicationConnection } from "../../utils/ConnectionManager.js";
import {
  collectEnvironmentPreflight,
  probePluginRuntime,
  probePort,
} from "../../utils/environmentPreflight.js";
import type { DomainToolDefinition } from "../domainRuntime.js";

const EnvironmentCheckSchema = z.object({
  id: z.string(),
  label: z.string(),
  status: z.enum(["ok", "warn", "fail"]),
  value: z.string(),
  detail: z.string().optional(),
});

const EnvironmentReportSchema = z.object({
  status: z.enum(["ok", "warn", "fail"]),
  summary: z.object({
    ok: z.number(),
    warn: z.number(),
    fail: z.number(),
  }),
  checks: z.array(EnvironmentCheckSchema),
});

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
  /** Environment preflight. Optional, so a payload without it still validates. */
  environment: EnvironmentReportSchema.optional(),
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
      // The health surface also carries a reduced environment preflight. It ships
      // in the plugin payload, so it needs the plugin to have answered: an
      // unreachable plugin still fails this tool with the same connection error
      // it always raised, and the port observation is then discarded with it.
      execute: async () => {
        const endpoint = getPluginEndpoint();
        const port = await probePort(endpoint.host, endpoint.port);
        const probe = await withApplicationConnection(
          async (appClient) => await probePluginRuntime(appClient),
        );
        if (probe.load !== "loaded" || probe.payload === null) {
          throw probe.error ?? new Error("The Civil 3D plugin did not answer the health command.");
        }
        const environment = collectEnvironmentPreflight({
          endpoint: `${endpoint.host}:${endpoint.port}`,
          port,
          load: probe.load,
          pluginVersion: probe.pluginVersion,
        });
        return { ...probe.payload, environment };
      },
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
