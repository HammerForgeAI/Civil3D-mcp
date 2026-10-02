import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isApprovalRequired } from "../src/tools/approvalPolicy.js";
import { buildExposureAnnotations, captureDomainToolHandlers } from "../src/tools/domainRuntime.js";
import { getToolHandler } from "../src/tools/toolHandlerRegistry.js";
import { DRAWING_RUNTIME_DOMAIN_DEFINITION } from "../src/tools/domains/drawingRuntimeDomain.js";
import { GENERATED_TOOL_CATALOG_ENTRIES, findManifestAction } from "../src/tools/toolManifest.js";
import type { DomainToolDefinition } from "../src/tools/domainRuntime.js";

const pluginDirectory = fileURLToPath(new URL("../Civil3D-MCP-Plugin/", import.meta.url));
const projectFile = readFileSync(new URL("../Civil3D-MCP-Plugin/Civil3DMcpPlugin.csproj", import.meta.url), "utf8");
const compatibilitySource = readFileSync(`${pluginDirectory}/Civil3DCompatibility.cs`, "utf8");
const scriptHostSource = readFileSync(`${pluginDirectory}/ScriptHostCommands.cs`, "utf8");
const rawCommandSource = readFileSync(`${pluginDirectory}/RawCommandCommands.cs`, "utf8");
const tokenGuardSource = readFileSync(`${pluginDirectory}/ApprovalTokenGuard.cs`, "utf8");

captureDomainToolHandlers(DRAWING_RUNTIME_DOMAIN_DEFINITION);

function approvalFor(definition: DomainToolDefinition, toolName: string, action: string): boolean {
  const actionDefinition = definition.actions[action];
  expect(actionDefinition, `${toolName}.${action} is defined`).toBeDefined();
  return isApprovalRequired({
    toolName,
    action,
    capabilities: actionDefinition.capabilities,
    safeForRetry: actionDefinition.safeForRetry,
    requiresActiveDrawing: actionDefinition.requiresActiveDrawing,
  });
}

async function callDrawing(rawArgs: Record<string, unknown>) {
  const handler = getToolHandler("civil3d_drawing");
  expect(handler, "civil3d_drawing handler is captured").toBeDefined();
  return await handler!(rawArgs, {});
}

function resultText(result: { content?: Array<{ text?: string }> }): string {
  return result.content?.map((item) => item.text ?? "").join("\n") ?? "";
}

describe("P11 escape hatches (items 16 and 1)", () => {
  it("registers both escape hatches on the existing civil3d_drawing domain", () => {
    const entry = GENERATED_TOOL_CATALOG_ENTRIES.find((item) => item.toolName === "civil3d_drawing");

    expect(entry).toBeDefined();
    expect(entry!.domain).toBe("drawing");
    expect(entry!.operations).toEqual(expect.arrayContaining([
      "send_command", "execute_script", "list_instances", "select_instance",
    ]));
    expect(entry!.pluginMethods).toEqual(expect.arrayContaining([
      "sendCommand", "executeCSharpScript", "getListenerInstance",
    ]));

    for (const action of ["send_command", "execute_script", "list_instances", "select_instance"]) {
      expect(findManifestAction("civil3d_drawing", action), action).toBeDefined();
    }
  });

  it("classifies both escape hatches as approval-gated mutations", () => {
    expect(approvalFor(DRAWING_RUNTIME_DOMAIN_DEFINITION, "civil3d_drawing", "send_command")).toBe(true);
    expect(approvalFor(DRAWING_RUNTIME_DOMAIN_DEFINITION, "civil3d_drawing", "execute_script")).toBe(true);
    expect(DRAWING_RUNTIME_DOMAIN_DEFINITION.actions.send_command.safeForRetry).toBe(false);
    expect(DRAWING_RUNTIME_DOMAIN_DEFINITION.actions.execute_script.safeForRetry).toBe(false);
    expect(DRAWING_RUNTIME_DOMAIN_DEFINITION.actions.send_command.capabilities).toContain("edit");
    expect(DRAWING_RUNTIME_DOMAIN_DEFINITION.actions.execute_script.capabilities).toContain("manage");
    expect(DRAWING_RUNTIME_DOMAIN_DEFINITION.actions.execute_script.requiresActiveDrawing).toBe(true);
  });

  it("refuses send_command with no approval token, before any plugin connection", async () => {
    const result = await callDrawing({ action: "send_command", command: "LINE" });
    const text = resultText(result);

    expect(result.isError).toBe(true);
    expect(text).toContain("Approval required for 'civil3d_drawing' action 'send_command'");
    expect(text).not.toContain("Failed to connect");
  });

  it("refuses a forged approval token, before any plugin connection", async () => {
    const result = await callDrawing({
      action: "send_command",
      command: "LINE",
      approvalToken: "forged-token",
    });
    const text = resultText(result);

    expect(result.isError).toBe(true);
    expect(text).toContain("Approval token is missing, expired, or has already been used.");
    expect(text).not.toContain("Failed to connect");
  });

  it("keeps the script host unreachable without an approval token", async () => {
    const withoutToken = await callDrawing({ action: "execute_script", code: "return 1;" });
    expect(withoutToken.isError).toBe(true);
    expect(resultText(withoutToken)).toContain("Approval required for 'civil3d_drawing' action 'execute_script'");
    expect(resultText(withoutToken)).not.toContain("Failed to connect");

    const forged = await callDrawing({ action: "execute_script", code: "return 1;", approvalToken: "forged-token" });
    expect(forged.isError).toBe(true);
    expect(resultText(forged)).toContain("Approval token is missing, expired, or has already been used.");
    expect(resultText(forged)).not.toContain("Failed to connect");
  });

  it("annotates the drawing tool as mutating and destructive", () => {
    const annotations = buildExposureAnnotations(DRAWING_RUNTIME_DOMAIN_DEFINITION, DRAWING_RUNTIME_DOMAIN_DEFINITION.exposures[0]);

    expect(annotations.readOnlyHint).toBe(false);
    expect(annotations.destructiveHint).toBe(true);
    expect(annotations.idempotentHint).toBe(false);
  });

  it("validates escape-hatch input and leaves the instance list readable", () => {
    const send = DRAWING_RUNTIME_DOMAIN_DEFINITION.actions.send_command.inputSchema;
    expect(send.safeParse({ action: "send_command", command: "LINE" }).success).toBe(true);
    expect(send.safeParse({ action: "send_command", command: "" }).success).toBe(false);
    expect(send.safeParse({ action: "send_command", command: "LINE", arguments: [] }).success).toBe(false);
    expect(send.safeParse({
      action: "send_command",
      command: "-LAYER",
      arguments: Array.from({ length: 41 }, () => "x"),
    }).success).toBe(false);

    const script = DRAWING_RUNTIME_DOMAIN_DEFINITION.actions.execute_script.inputSchema;
    expect(script.safeParse({ action: "execute_script", code: "return 1;" }).success).toBe(true);
    expect(script.safeParse({ action: "execute_script" }).success).toBe(false);
    expect(script.safeParse({ action: "execute_script", code: "", timeoutSeconds: 0 }).success).toBe(false);

    expect(approvalFor(DRAWING_RUNTIME_DOMAIN_DEFINITION, "civil3d_drawing", "list_instances")).toBe(false);
    expect(DRAWING_RUNTIME_DOMAIN_DEFINITION.actions.list_instances.safeForRetry).toBe(true);
    expect(approvalFor(DRAWING_RUNTIME_DOMAIN_DEFINITION, "civil3d_drawing", "select_instance")).toBe(true);

    const listResponse = DRAWING_RUNTIME_DOMAIN_DEFINITION.actions.list_instances.responseSchema!;
    expect(listResponse.safeParse({
      active: { label: "default", host: "localhost", port: 8080, isDefault: true },
      instances: [{ label: "alpha", host: "127.0.0.1", port: 8081, connected: null, active: true }],
    }).success).toBe(true);

    const selectResponse = DRAWING_RUNTIME_DOMAIN_DEFINITION.actions.select_instance.responseSchema!;
    expect(selectResponse.safeParse({
      active: { label: "alpha", host: "127.0.0.1", port: 8081 },
      connected: true,
      instanceId: "abc",
      listenerPort: 8081,
    }).success).toBe(true);
  });

  it("requires the approval token again inside the plugin", () => {
    expect(tokenGuardSource).toContain("ApprovalTokenGuard");
    expect(tokenGuardSource).toContain("CIVIL3D.FORBIDDEN");
    expect(tokenGuardSource).toContain("already been used");
    expect(rawCommandSource).toContain("ApprovalTokenGuard.Require(parameters, \"sendCommand\")");
    expect(scriptHostSource).toContain("ApprovalTokenGuard.Require(parameters, \"executeCSharpScript\")");
  });

  it("refuses the raw commands that would bypass the file boundary", () => {
    for (const command of ["SAVEAS", "OPEN", "XREF", "INSERT", "PLOT", "EXPORT", "NETLOAD", "ARX", "APPLOAD", "SETVAR"]) {
      expect(rawCommandSource, command).toContain(`"${command}"`);
    }
    expect(rawCommandSource).toContain("CIVIL3D.FORBIDDEN");
    // The line must stay a single unquoted argv-style command.
    expect(rawCommandSource).toContain("ForbiddenCharacters");
    // No token may name a file, because command names can be aliases.
    expect(rawCommandSource).toContain("RejectFileTokens(parts)");
    expect(rawCommandSource).toContain("NamesAFile");
    expect(rawCommandSource).toContain("names a file");
  });

  it("keeps Roslyn's assembly resolution inside the reflection boundary", () => {
    expect(compatibilitySource).toContain("GetLoadedScriptReferenceAssemblies");
    expect(compatibilitySource).toContain("AppDomain.CurrentDomain.GetAssemblies()");
    expect(scriptHostSource).toContain("Civil3DCompatibility.GetLoadedScriptReferenceAssemblies()");
    expect(scriptHostSource).not.toContain("AppDomain");
    expect(scriptHostSource).not.toContain("System.Reflection");
    expect(scriptHostSource).not.toContain("BindingFlags");
  });

  it("pins the Roslyn scripting package as the first PackageReference", () => {
    const references = [...projectFile.matchAll(/<PackageReference Include="([^"]+)" Version="([^"]+)"/g)]
      .map((match) => ({ id: match[1], version: match[2] }));

    expect(references).toEqual([{ id: "Microsoft.CodeAnalysis.CSharp.Scripting", version: "4.12.0" }]);
  });
});
