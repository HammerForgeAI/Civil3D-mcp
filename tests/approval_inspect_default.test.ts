import { beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  APPROVAL_AUDIT_LIST_LIMIT,
  ApprovalPolicyService,
  ApprovalRequiredError,
  ApprovalValidationError,
  DEFAULT_APPROVAL_OPERATING_MODE,
  MAX_APPROVAL_AUDIT_EVENTS,
  clearApprovalAuditLogForTesting,
  getApprovalPosture,
  hashApprovalInput,
  isApprovalRequired,
  listApprovalAuditEvents,
  redactApprovalInput,
  resolveApprovalOperatingMode,
} from "../src/tools/approvalPolicy.js";
import { registerTools } from "../src/tools/register.js";

const saveTarget = {
  toolName: "civil3d_drawing",
  action: "save",
  capabilities: ["edit", "manage"] as const,
  safeForRetry: false,
};

const readTarget = {
  toolName: "get_drawing_info",
  action: "info",
  capabilities: ["query", "inspect"] as const,
  safeForRetry: true,
};

async function withApprovalMode<T>(value: string | undefined, body: () => Promise<T> | T): Promise<T> {
  const saved = process.env.CIVIL3D_APPROVAL_MODE;
  if (value === undefined) {
    delete process.env.CIVIL3D_APPROVAL_MODE;
  } else {
    process.env.CIVIL3D_APPROVAL_MODE = value;
  }
  try {
    return await body();
  } finally {
    if (saved === undefined) {
      delete process.env.CIVIL3D_APPROVAL_MODE;
    } else {
      process.env.CIVIL3D_APPROVAL_MODE = saved;
    }
  }
}

describe("approval inspect-only default", () => {
  beforeEach(() => clearApprovalAuditLogForTesting());

  it("defaults to inspect-only and refuses to widen on its own", async () => {
    expect(DEFAULT_APPROVAL_OPERATING_MODE).toBe("inspect-only");
    expect(resolveApprovalOperatingMode({})).toBe("inspect-only");
    expect(getApprovalPosture({})).toEqual({
      operatingMode: "inspect-only",
      inspectOnly: true,
      mutatingActionsRequireApprovalToken: true,
    });

    await withApprovalMode(undefined, () => {
      expect(resolveApprovalOperatingMode()).toBe("inspect-only");
      expect(getApprovalPosture().inspectOnly).toBe(true);
    });

    // The donor's wider postures and any unrecognised value stay narrow.
    for (const configured of ["inspect", "inspect_only", "read-only", "assisted", "automation", "banana", "  "]) {
      expect(resolveApprovalOperatingMode({ CIVIL3D_APPROVAL_MODE: configured }), configured).toBe("inspect-only");
    }
  });

  it("keeps the explicit disabled opt-out as the only widening", async () => {
    expect(resolveApprovalOperatingMode({ CIVIL3D_APPROVAL_MODE: "disabled" })).toBe("disabled");
    expect(getApprovalPosture({ CIVIL3D_APPROVAL_MODE: "disabled" })).toEqual({
      operatingMode: "disabled",
      inspectOnly: false,
      mutatingActionsRequireApprovalToken: false,
    });

    await withApprovalMode("disabled", () => {
      expect(isApprovalRequired(saveTarget)).toBe(false);
    });
  });

  it("runs a read-only action with no approval and still gates every mutation", () => {
    expect(isApprovalRequired(readTarget, "inspect-only")).toBe(false);
    expect(isApprovalRequired(saveTarget, "inspect-only")).toBe(true);
  });

  it("does not weaken the token flow: a mutating action still needs its token", async () => {
    const policy = new ApprovalPolicyService(async () => "drawing-a");
    await expect(policy.enforce(saveTarget, { action: "save" })).rejects.toBeInstanceOf(ApprovalRequiredError);

    const parameters = { action: "save", saveAs: "C:/work/design.dwg" };
    const receipt = await policy.requestApproval(saveTarget, parameters, 30_000);
    await expect(policy.enforce(saveTarget, { ...parameters, approvalToken: receipt.approvalToken }))
      .resolves.toBeUndefined();
    await expect(policy.enforce(saveTarget, { ...parameters, approvalToken: receipt.approvalToken }))
      .rejects.toBeInstanceOf(ApprovalValidationError);
  });

  it("records a redacted audit event for the not-required read-only default", async () => {
    const policy = new ApprovalPolicyService(async () => "drawing-a");
    await policy.enforce(readTarget, { action: "info", drawingName: "design.dwg" });

    const events = listApprovalAuditEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      toolName: "get_drawing_info",
      action: "info",
      operatingMode: "inspect-only",
      approvalState: "not_required",
      resultStatus: "success",
    });
    expect(events[0]!.inputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(events[0]!.durationMs).toBeGreaterThanOrEqual(0);
    // The audit trail carries the hash, never the parameter values.
    expect(JSON.stringify(events)).not.toContain("design.dwg");
  });

  it("records denied, expired and approved decisions without retaining the token", async () => {
    let drawing = "drawing-a";
    let now = 1_000;
    const policy = new ApprovalPolicyService(async () => drawing, () => now);
    const parameters = { action: "save", saveAs: "C:/work/design.dwg" };

    await expect(policy.enforce(saveTarget, parameters)).rejects.toBeInstanceOf(ApprovalRequiredError);
    const expiredReceipt = await policy.requestApproval(saveTarget, parameters, 30_000);
    now += 31_000;
    await expect(policy.enforce(saveTarget, { ...parameters, approvalToken: expiredReceipt.approvalToken }))
      .rejects.toBeInstanceOf(ApprovalValidationError);

    const receipt = await policy.requestApproval(saveTarget, parameters, 30_000);
    await policy.enforce(saveTarget, { ...parameters, approvalToken: receipt.approvalToken });

    const events = listApprovalAuditEvents();
    expect(events.map((event) => event.approvalState)).toEqual([
      "pending",
      "pending",
      "expired",
      "pending",
      "approved",
    ]);
    expect(events.map((event) => event.errorCode)).toEqual([
      "APPROVAL_REQUIRED",
      undefined,
      "APPROVAL_TOKEN_EXPIRED",
      undefined,
      undefined,
    ]);
    expect(events.at(-1)).toMatchObject({ approvalState: "approved", resultStatus: "success" });
    expect(JSON.stringify(events)).not.toContain(receipt.approvalToken);
    expect(JSON.stringify(events)).not.toContain(expiredReceipt.approvalToken);
  });

  it("keeps the audit log bounded and hashes parameters regardless of key order", async () => {
    const policy = new ApprovalPolicyService(async () => "drawing-a");
    for (let index = 0; index < MAX_APPROVAL_AUDIT_EVENTS + 5; index += 1) {
      await policy.enforce(readTarget, { action: "info", index });
    }

    expect(listApprovalAuditEvents(MAX_APPROVAL_AUDIT_EVENTS + 100)).toHaveLength(MAX_APPROVAL_AUDIT_EVENTS);
    expect(listApprovalAuditEvents(APPROVAL_AUDIT_LIST_LIMIT)).toHaveLength(APPROVAL_AUDIT_LIST_LIMIT);
    expect(listApprovalAuditEvents(0)).toEqual([]);
    expect(hashApprovalInput({ a: 1, b: 2 })).toBe(hashApprovalInput({ b: 2, a: 1 }));
    expect(redactApprovalInput({ approvalToken: "secret", keep: "value" }))
      .toEqual({ approvalToken: "[REDACTED]", keep: "value" });
  });

  it("publishes the audit trail and the posture as the civil3d://audit/history resource", async () => {
    const policy = new ApprovalPolicyService(async () => "drawing-a");
    await policy.enforce(readTarget, { action: "info" });

    const server = new McpServer({ name: "approval-audit-test", version: "0.0.0" });
    await registerTools(server);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "approval-audit-client", version: "0.0.0" });
    await client.connect(clientTransport);

    try {
      const resources = await client.listResources();
      expect(resources.resources.map((resource) => resource.uri)).toContain("civil3d://audit/history");

      const read = await client.readResource({ uri: "civil3d://audit/history" });
      const payload = JSON.parse((read.contents[0] as { text: string }).text) as {
        posture: { operatingMode: string; inspectOnly: boolean; mutatingActionsRequireApprovalToken: boolean };
        retention: { maxEvents: number; returnedEvents: number };
        events: Array<{ toolName: string; approvalState: string }>;
      };

      expect(payload.posture).toEqual({ operatingMode: "inspect-only", inspectOnly: true, mutatingActionsRequireApprovalToken: true });
      expect(payload.retention).toEqual({ maxEvents: MAX_APPROVAL_AUDIT_EVENTS, returnedEvents: 1 });
      expect(payload.events[0]).toMatchObject({ toolName: "get_drawing_info", approvalState: "not_required" });
    } finally {
      await client.close();
      await server.close();
    }
  });
});
