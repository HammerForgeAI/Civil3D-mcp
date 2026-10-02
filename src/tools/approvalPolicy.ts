import { createHash, randomUUID } from "node:crypto";
import { withApplicationConnection } from "../utils/ConnectionManager.js";
import { Civil3DRpcError } from "../utils/SocketClient.js";
import type { ToolCapability } from "./toolMetadata.js";

type JsonObject = Record<string, unknown>;

export interface ApprovalTarget {
  toolName: string;
  action: string;
  capabilities: ToolCapability[];
  safeForRetry: boolean;
  requiresActiveDrawing?: boolean;
}

interface ApprovalGrant {
  toolName: string;
  action: string;
  parametersHash: string;
  drawingFingerprint: string;
  expiresAt: number;
  /** Set for tokens issued by requestPlan: they belong to an ordered plan on ONE document. */
  planId?: string;
  stepIndex?: number;
}

interface PlanState {
  documentId: string;
  length: number;
  nextIndex: number;
  expiresAt: number;
}

export interface PlanStepInput {
  target: ApprovalTarget;
  parameters: JsonObject;
}

export interface PlanApprovalReceipt {
  planId: string;
  documentId: string;
  expiresAt: string;
  steps: Array<{ index: number; toolName: string; action: string; approvalToken: string }>;
}

export const MAX_PLAN_STEPS = 40;
export const MAX_PLAN_TTL_MS = 30 * 60 * 1000;

export interface ApprovalReceipt {
  approvalToken: string;
  expiresAt: string;
  drawingFingerprint: string;
}

export class ApprovalRequiredError extends Error {}

export class ApprovalValidationError extends Error {}

export type DrawingFingerprintProvider = () => Promise<string>;

const APPROVAL_TOKEN_TTL_MS = 5 * 60 * 1000;
const NO_ACTIVE_DRAWING_FINGERPRINT = "no-active-drawing";
const MUTATING_CAPABILITIES = new Set<ToolCapability>([
  "create",
  "edit",
  "delete",
  "manage",
  "import",
  "export",
]);
const EXPLICIT_APPROVAL_ACTION = /(?:^|_)(?:delete|remove|import|export|save|new|undo|redo|overwrite|replace|publish|promote|sync|fix|remediate)(?:_|$)/i;

/**
 * Two postures, not the donor's three (Venkatchavan/OpenAEC-MCP, Apache-2.0:
 * apps/mcp-server/src/server.ts and packages/safety-engine/src/index.ts,
 * `OperatingModeSchema`: inspect | assisted | automation). The fork has no
 * auto-approval ladder: "assisted" and "automation" behave exactly like the
 * inspect-only default here, because every mutating action still passes through
 * the approval-token flow. "disabled" is the fork's pre-existing explicit
 * opt-out (CIVIL3D_APPROVAL_MODE=disabled), which is the only way to widen the
 * posture, and an operator must set it deliberately.
 */
export type ApprovalOperatingMode = "inspect-only" | "disabled";

export const DEFAULT_APPROVAL_OPERATING_MODE: ApprovalOperatingMode = "inspect-only";

export interface ApprovalPosture {
  operatingMode: ApprovalOperatingMode;
  /** True for the default posture: a read-only run needs no approval round-trip. */
  inspectOnly: boolean;
  /** True for every posture except the explicit opt-out: mutations still need a token. */
  mutatingActionsRequireApprovalToken: boolean;
}

const DISABLED_MODE_VALUES = new Set(["disabled", "off", "none"]);

/**
 * Reads the approval posture. The donor's default is `inspect` (its
 * `PolicySchema.mode.default('inspect')`), and so is this one: `CIVIL3D_APPROVAL_MODE`
 * unset means inspect-only. Accepted spellings of that posture are "inspect",
 * "inspect-only" and "read-only"; the donor's wider values ("assisted",
 * "automation") and any unrecognised value also resolve to it, so this function
 * can never widen the posture by accident - it only honours the explicit
 * "disabled" opt-out.
 */
export function resolveApprovalOperatingMode(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ApprovalOperatingMode {
  const configured = (env.CIVIL3D_APPROVAL_MODE ?? "").trim().toLowerCase().replace(/[\s_]+/g, "-");
  return DISABLED_MODE_VALUES.has(configured) ? "disabled" : DEFAULT_APPROVAL_OPERATING_MODE;
}

export function getApprovalPosture(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ApprovalPosture {
  const operatingMode = resolveApprovalOperatingMode(env);
  return {
    operatingMode,
    inspectOnly: operatingMode === "inspect-only",
    mutatingActionsRequireApprovalToken: operatingMode !== "disabled",
  };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }

  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

function hashParameters(parameters: JsonObject): string {
  const normalized = { ...parameters };
  delete normalized.approvalToken;
  return createHash("sha256").update(stableJson(normalized)).digest("hex");
}

export function isApprovalRequired(
  target: ApprovalTarget,
  operatingMode: ApprovalOperatingMode = resolveApprovalOperatingMode(),
): boolean {
  if (operatingMode === "disabled") {
    return false;
  }

  return hasApprovalRisk(target);
}

export function hasApprovalRisk(target: ApprovalTarget): boolean {
  const mutatesState = target.capabilities.some((capability) => MUTATING_CAPABILITIES.has(capability));
  return (
    target.capabilities.some((capability) => ["delete", "import", "export"].includes(capability)) ||
    EXPLICIT_APPROVAL_ACTION.test(target.action) ||
    (!target.safeForRetry && mutatesState)
  );
}

/**
 * Redacted approval audit trail, ported from the donor's audit-logger package
 * (Venkatchavan/OpenAEC-MCP, Apache-2.0: packages/audit-logger/src/index.ts -
 * `redact`, `hashInput`, `MemoryAuditLogger.list` - and its
 * `aec://audit/history` resource) and published as the
 * `civil3d://audit/history` resource. Every `enforce` decision is recorded,
 * including the inspect-only default's `not_required` outcome, so a read-only
 * run leaves the same evidence as a mutation - without retaining any parameter
 * value, only a hash of the redacted parameters.
 */
export type ApprovalAuditState = "not_required" | "pending" | "approved" | "denied" | "expired";
export type ApprovalAuditResult = "success" | "failure" | "denied";

export interface ApprovalAuditEvent {
  timestamp: string;
  toolName: string;
  action: string;
  operatingMode: ApprovalOperatingMode;
  approvalState: ApprovalAuditState;
  inputHash: string;
  resultStatus: ApprovalAuditResult;
  durationMs: number;
  errorCode?: string;
}

export const MAX_APPROVAL_AUDIT_EVENTS = 200;
export const APPROVAL_AUDIT_LIST_LIMIT = 100;

const AUDIT_SENSITIVE_KEY = /token|secret|password|credential|authorization|signed.?url|drawing.?content/i;

export function redactApprovalInput(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactApprovalInput(item));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([key, nested]) => [key, AUDIT_SENSITIVE_KEY.test(key) ? "[REDACTED]" : redactApprovalInput(nested)]),
    );
  }

  return value;
}

export function hashApprovalInput(value: unknown): string {
  return createHash("sha256").update(stableJson(redactApprovalInput(value))).digest("hex");
}

const approvalAuditLog: ApprovalAuditEvent[] = [];

function recordApprovalAuditEvent(event: ApprovalAuditEvent): void {
  approvalAuditLog.push(event);
  while (approvalAuditLog.length > MAX_APPROVAL_AUDIT_EVENTS) {
    approvalAuditLog.shift();
  }
}

export function listApprovalAuditEvents(limit = APPROVAL_AUDIT_LIST_LIMIT): ApprovalAuditEvent[] {
  if (limit <= 0) {
    return [];
  }

  return approvalAuditLog.slice(-limit);
}

export function clearApprovalAuditLogForTesting(): void {
  approvalAuditLog.length = 0;
}

/** Identity of the active document (path/name only, NOT its contents): stays stable while a plan mutates the drawing. */
export async function getActiveDocumentIdentity(): Promise<string> {
  const info = await withApplicationConnection((client) => client.sendCommand("getDrawingInfo", {})) as JsonObject | null;
  const identity = String(info?.filePath ?? info?.drawingName ?? info?.fileName ?? "");
  return createHash("sha256").update(identity).digest("hex");
}

export async function getActiveDrawingFingerprint(): Promise<string> {
  const drawingInfo = await withApplicationConnection(async (client) => {
    // Ask the ungated health endpoint before touching drawing state. Older
    // plugin builds never answer getDrawingInfo when no document is open (the
    // request wedges the host execution gate), so surface NO_DRAWING here
    // instead of waiting out CIVIL3D_COMMAND_TIMEOUT.
    const health = await client.sendCommand("getCivil3DHealth", {});
    if (health && typeof health === "object" && (health as JsonObject).drawingLoaded === false) {
      throw new Civil3DRpcError("No active drawing is open in Civil 3D.", "CIVIL3D.NO_DRAWING", -32001);
    }
    return await client.sendCommand("getDrawingInfo", {});
  });
  return createHash("sha256").update(stableJson(drawingInfo)).digest("hex");
}

function isNoActiveDrawingError(error: unknown): boolean {
  const code = error && typeof error === "object" && "code" in error
    ? String(error.code)
    : "";
  const message = error instanceof Error ? error.message : String(error);
  return code === "CIVIL3D.NO_DRAWING" || code === "CIVIL3D.NO_ACTIVE_DRAWING" ||
    /no active (?:civil 3d )?drawing|no active (?:civil 3d )?document/i.test(message);
}

export class ApprovalPolicyService {
  private readonly grants = new Map<string, ApprovalGrant>();
  private readonly plans = new Map<string, PlanState>();

  public constructor(
    private readonly drawingFingerprint: DrawingFingerprintProvider = getActiveDrawingFingerprint,
    private readonly now: () => number = () => Date.now(),
    private readonly documentIdentity: DrawingFingerprintProvider = getActiveDocumentIdentity,
  ) {}

  /**
   * Approves an ORDERED list of exact actions in one call (e.g. the ~10 steps of a Fase 1 clean-up). Each step gets its own
   * single-use token bound to its exact parameters; the whole plan is bound to the active DOCUMENT (not to its contents, which
   * every step changes) and steps must be executed in order. Any deviation (other document, other parameters, skipped step,
   * expiry) is rejected exactly like a single-step token.
   */
  public async requestPlan(
    steps: PlanStepInput[],
    ttlMs = 15 * 60 * 1000,
  ): Promise<PlanApprovalReceipt> {
    const startedAt = this.now();
    if (steps.length === 0) {
      this.auditPlan(steps, "pending", "failure", startedAt, "APPROVAL_PLAN_EMPTY");
      throw new ApprovalValidationError("A plan needs at least one step.");
    }
    if (steps.length > MAX_PLAN_STEPS) {
      this.auditPlan(steps, "pending", "failure", startedAt, "APPROVAL_PLAN_TOO_LARGE");
      throw new ApprovalValidationError(`A plan may have at most ${MAX_PLAN_STEPS} steps (got ${steps.length}); split it.`);
    }
    steps.forEach((step, index) => {
      if (!isApprovalRequired(step.target)) {
        this.auditPlan(steps, "not_required", "failure", startedAt, "APPROVAL_PLAN_STEP_NOT_REQUIRED");
        throw new ApprovalValidationError(
          `Plan step ${index} ('${step.target.toolName}' action '${step.target.action}') does not require approval; remove it from the plan and execute it directly.`,
        );
      }
    });

    const boundedTtl = Math.min(ttlMs, MAX_PLAN_TTL_MS);
    const expiresAt = this.now() + boundedTtl;
    const documentId = await this.documentIdentity();
    const drawingFingerprint = await this.drawingFingerprint();
    const planId = randomUUID();
    this.plans.set(planId, { documentId, length: steps.length, nextIndex: 0, expiresAt });

    const issued = steps.map((step, index) => {
      const approvalToken = randomUUID();
      this.grants.set(approvalToken, {
        toolName: step.target.toolName,
        action: step.target.action,
        parametersHash: hashParameters(step.parameters),
        drawingFingerprint,
        expiresAt,
        planId,
        stepIndex: index,
      });
      return { index, toolName: step.target.toolName, action: step.target.action, approvalToken };
    });

    this.auditPlan(steps, "pending", "success", startedAt);
    return { planId, documentId, expiresAt: new Date(expiresAt).toISOString(), steps: issued };
  }

  private async fingerprintFor(target: ApprovalTarget): Promise<string> {
    try {
      return await this.drawingFingerprint();
    } catch (error) {
      if (target.requiresActiveDrawing === false && isNoActiveDrawingError(error)) {
        return NO_ACTIVE_DRAWING_FINGERPRINT;
      }
      throw error;
    }
  }

  public async requestApproval(
    target: ApprovalTarget,
    parameters: JsonObject,
    ttlMs = APPROVAL_TOKEN_TTL_MS,
  ): Promise<ApprovalReceipt> {
    const startedAt = this.now();
    if (!isApprovalRequired(target)) {
      this.audit(target, parameters, "not_required", "failure", startedAt, "APPROVAL_NOT_REQUIRED");
      throw new ApprovalValidationError(
        `'${target.toolName}' action '${target.action}' does not require approval. Execute it directly.`,
      );
    }

    let drawingFingerprint: string;
    try {
      drawingFingerprint = await this.fingerprintFor(target);
    } catch (error) {
      this.audit(target, parameters, "pending", "failure", startedAt, "APPROVAL_CONTEXT_UNAVAILABLE");
      throw error;
    }

    const expiresAt = this.now() + ttlMs;
    const approvalToken = randomUUID();
    this.grants.set(approvalToken, {
      toolName: target.toolName,
      action: target.action,
      parametersHash: hashParameters(parameters),
      drawingFingerprint,
      expiresAt,
    });

    this.audit(target, parameters, "pending", "success", startedAt);
    return {
      approvalToken,
      expiresAt: new Date(expiresAt).toISOString(),
      drawingFingerprint,
    };
  }

  public async enforce(target: ApprovalTarget, parameters: JsonObject): Promise<void> {
    const startedAt = this.now();
    if (!isApprovalRequired(target)) {
      // The inspect-only default: a read-only run needs no approval, and the
      // audit trail records that the decision was "not required", not skipped.
      this.audit(target, parameters, "not_required", "success", startedAt);
      return;
    }

    const approvalToken = typeof parameters.approvalToken === "string" ? parameters.approvalToken : undefined;
    if (!approvalToken) {
      this.audit(target, parameters, "pending", "denied", startedAt, "APPROVAL_REQUIRED");
      throw new ApprovalRequiredError(
        `Approval required for '${target.toolName}' action '${target.action}'. ` +
        "Call civil3d_request_approval with the same toolName, action, and parameters, then retry with approvalToken.",
      );
    }

    const grant = this.grants.get(approvalToken);
    if (!grant) {
      this.audit(target, parameters, "denied", "denied", startedAt, "APPROVAL_TOKEN_INVALID");
      throw new ApprovalValidationError("Approval token is missing, expired, or has already been used.");
    }

    this.grants.delete(approvalToken);

    if (grant.expiresAt <= this.now()) {
      this.audit(target, parameters, "expired", "denied", startedAt, "APPROVAL_TOKEN_EXPIRED");
      throw new ApprovalValidationError("Approval token has expired. Request a new approval.");
    }

    if (
      grant.toolName !== target.toolName ||
      grant.action !== target.action ||
      grant.parametersHash !== hashParameters(parameters)
    ) {
      this.audit(target, parameters, "denied", "denied", startedAt, "APPROVAL_TOKEN_MISMATCH");
      throw new ApprovalValidationError("Approval token does not match this tool action and its parameters.");
    }

    if (grant.planId !== undefined) {
      const plan = this.plans.get(grant.planId);
      if (!plan || plan.expiresAt <= this.now()) {
        this.plans.delete(grant.planId);
        this.audit(target, parameters, "expired", "denied", startedAt, "APPROVAL_PLAN_EXPIRED");
        throw new ApprovalValidationError("The approved plan has expired. Request a new plan approval.");
      }
      if (grant.stepIndex !== plan.nextIndex) {
        this.audit(target, parameters, "denied", "denied", startedAt, "APPROVAL_PLAN_OUT_OF_ORDER");
        throw new ApprovalValidationError(
          `Plan steps must run in order: expected step ${plan.nextIndex}, got step ${grant.stepIndex}. Request a new plan approval.`,
        );
      }
      if (plan.documentId !== await this.documentIdentity()) {
        this.audit(target, parameters, "denied", "denied", startedAt, "APPROVAL_DOCUMENT_CHANGED");
        throw new ApprovalValidationError("The active document changed after the plan was approved. Request approval for the current document.");
      }
      plan.nextIndex += 1;
      if (plan.nextIndex >= plan.length) {
        this.plans.delete(grant.planId);
      }
      this.audit(target, parameters, "approved", "success", startedAt);
      return;
    }

    const activeDrawingFingerprint = await this.fingerprintFor(target);
    if (grant.drawingFingerprint !== activeDrawingFingerprint) {
      this.audit(target, parameters, "denied", "denied", startedAt, "APPROVAL_DRAWING_CHANGED");
      throw new ApprovalValidationError("The active drawing changed after approval. Request approval for the current drawing.");
    }

    this.audit(target, parameters, "approved", "success", startedAt);
  }

  private audit(
    target: ApprovalTarget,
    parameters: JsonObject,
    approvalState: ApprovalAuditState,
    resultStatus: ApprovalAuditResult,
    startedAt: number,
    errorCode?: string,
  ): void {
    recordApprovalAuditEvent({
      timestamp: new Date(this.now()).toISOString(),
      toolName: target.toolName,
      action: target.action,
      operatingMode: resolveApprovalOperatingMode(),
      approvalState,
      inputHash: hashApprovalInput(parameters),
      resultStatus,
      durationMs: Math.max(0, this.now() - startedAt),
      ...(errorCode === undefined ? {} : { errorCode }),
    });
  }

  private auditPlan(
    steps: PlanStepInput[],
    approvalState: ApprovalAuditState,
    resultStatus: ApprovalAuditResult,
    startedAt: number,
    errorCode?: string,
  ): void {
    recordApprovalAuditEvent({
      timestamp: new Date(this.now()).toISOString(),
      toolName: "civil3d_request_plan_approval",
      action: "plan_approval",
      operatingMode: resolveApprovalOperatingMode(),
      approvalState,
      inputHash: hashApprovalInput(steps.map((step) => ({ toolName: step.target.toolName, action: step.target.action, parameters: step.parameters }))),
      resultStatus,
      durationMs: Math.max(0, this.now() - startedAt),
      ...(errorCode === undefined ? {} : { errorCode }),
    });
  }
}

export const approvalPolicy = new ApprovalPolicyService();
