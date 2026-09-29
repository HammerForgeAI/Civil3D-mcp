import { describe, expect, it } from "vitest";
import { runFase1Build, summarizeFase1Build, type PluginSend } from "../src/tools/domains/fase1Build.js";

type Call = { method: string; params: Record<string, unknown> };

function fakePlugin(responses: Record<string, unknown | Error>, log: Call[]): PluginSend {
  return async (method, params) => {
    log.push({ method, params });
    const value = responses[method];
    if (value instanceof Error) throw value;
    if (value === undefined) throw new Error(`unexpected plugin call ${method}`);
    return value;
  };
}

const happyResponses: Record<string, unknown> = {
  newDrawing: { name: "FASE 1.dwg" },
  saveDrawing: { saved: true },
  attachXref: { xrefName: "X-TOPO" },
  createAlignment: { name: "SW 118TH AVE" },
  insertBlockReference: { handle: "AAA1" },
  createEntities: { createdCount: 2 },
  setViewportTwist: { twistDegrees: 268.49 },
  listTextEntities: { entities: [{ handle: "T1", text: "C-300  WATER AND SEWER PLAN  1\"=20'" }] },
  updateTextContent: { handle: "T1" },
};

describe("fase1 build", () => {
  it("runs every step in order and reports OK for a clean pipeline", async () => {
    const log: Call[] = [];
    const steps = await runFase1Build(fakePlugin(happyResponses, log), {
      templatePath: "C-300 template.dwg",
      saveAs: "PROJECT FASE 1.dwg",
      overwrite: true,
      xrefs: [{ filePath: "X-TOPO.dwg" }, { filePath: "X-UTIL.dwg" }],
      alignment: { name: "SW 118TH AVE", points: [{ x: 0, y: 0 }, { x: 440, y: 0 }], style: "BCC - ALIGNMENT", labelSet: "Major and Minor only" },
      entities: [{ kind: "mtext", text: "SW 118TH AVENUE" }],
      twists: [{ layout: "C-300", streetAngleDegrees: 91.51, centerX: 100, centerY: 200 }],
      titleBlock: [{ layout: "C-300", contains: "1\"=20'", find: "1\"=20'", replace: "AS SHOWN" }],
    });

    expect(summarizeFase1Build(steps).fail).toBe(0);
    expect(steps.every((s) => s.status === "OK")).toBe(true);
    expect(log.map((c) => c.method)).toEqual([
      "newDrawing",
      "saveDrawing", // save as
      "attachXref",
      "attachXref",
      "createAlignment",
      "createEntities",
      "setViewportTwist",
      "listTextEntities",
      "updateTextContent",
      "saveDrawing", // final save
    ]);
  });

  it("stops at the first failing step and marks the rest skipped, without undoing what already ran", async () => {
    const log: Call[] = [];
    const steps = await runFase1Build(
      fakePlugin({ ...happyResponses, attachXref: new Error("file not found") }, log),
      {
        templatePath: "C-300 template.dwg",
        saveAs: "PROJECT FASE 1.dwg",
        xrefs: [{ filePath: "X-TOPO.dwg" }],
        alignment: { name: "SW 118TH AVE", points: [{ x: 0, y: 0 }, { x: 440, y: 0 }] },
        entities: [{ kind: "mtext", text: "SW 118TH AVENUE" }],
      },
    );

    const totals = summarizeFase1Build(steps);
    expect(totals.fail).toBe(1);
    expect(steps.find((s) => s.name.startsWith("xref"))!.status).toBe("FAIL");
    expect(steps.find((s) => s.name.startsWith("alignment"))!.status).toBe("SKIPPED");
    expect(steps.find((s) => s.name.includes("entities"))!.status).toBe("SKIPPED");
    expect(steps.find((s) => s.name === "save")!.status).toBe("SKIPPED");
    // newDrawing and the initial save DID run and are not retried or reversed
    expect(log.filter((c) => c.method === "newDrawing")).toHaveLength(1);
  });

  it("imports the block definition for the first matching block entity and excludes it from the batch", async () => {
    const log: Call[] = [];
    await runFase1Build(fakePlugin(happyResponses, log), {
      clImport: { blockName: "_cl", sourceFilePath: "X-TOPO.dwg" },
      entities: [
        { kind: "block", blockName: "_cl", x: 10, y: 20, rotation: 0, scale: 30, layer: "TEXT" },
        { kind: "block", blockName: "_cl", x: 50, y: 60, rotation: 0, scale: 30, layer: "TEXT" },
        { kind: "mtext", text: "SW 118TH AVENUE" },
      ],
      save: false,
    });

    const importCall = log.find((c) => c.method === "insertBlockReference");
    expect(importCall).toBeDefined();
    expect(importCall!.params).toMatchObject({ blockName: "_cl", sourceFilePath: "X-TOPO.dwg", x: 10, y: 20 });

    const batchCall = log.find((c) => c.method === "createEntities");
    const batchEntities = batchCall!.params.entities as Array<Record<string, unknown>>;
    expect(batchEntities).toHaveLength(2); // the second _cl copy + the mtext, not the imported one
    expect(batchEntities.filter((e) => e.kind === "block")).toHaveLength(1);
  });

  it("skips the block import when no matching block entity is in the batch, and still builds the rest", async () => {
    const log: Call[] = [];
    const steps = await runFase1Build(fakePlugin(happyResponses, log), {
      clImport: { blockName: "_cl", sourceFilePath: "X-TOPO.dwg" },
      entities: [{ kind: "mtext", text: "SW 118TH AVENUE" }],
      save: false,
    });

    expect(steps.find((s) => s.name.includes("import block"))!.status).toBe("SKIPPED");
    expect(log.some((c) => c.method === "insertBlockReference")).toBe(false);
    expect(log.some((c) => c.method === "createEntities")).toBe(true);
  });

  it("edits only the matched substring of the title-block text and fails clearly when the substring is not found", async () => {
    const log: Call[] = [];
    const ok = await runFase1Build(fakePlugin(happyResponses, log), {
      titleBlock: [{ layout: "C-300", contains: "WATER AND SEWER", find: "1\"=20'", replace: "AS SHOWN" }],
      save: false,
    });
    expect(ok.every((s) => s.status === "OK")).toBe(true);
    const update = log.find((c) => c.method === "updateTextContent")!;
    expect(update.params.text).toBe("C-300  WATER AND SEWER PLAN  AS SHOWN");

    const log2: Call[] = [];
    const fails = await runFase1Build(fakePlugin(happyResponses, log2), {
      titleBlock: [{ layout: "C-300", contains: "WATER AND SEWER", find: "NOT PRESENT", replace: "X" }],
      save: false,
    });
    expect(fails.find((s) => s.name.includes("title block"))!.status).toBe("FAIL");
  });

  it("honours save:false by not issuing a final save", async () => {
    const log: Call[] = [];
    await runFase1Build(fakePlugin(happyResponses, log), {
      entities: [{ kind: "mtext", text: "x" }],
      save: false,
    });
    expect(log.filter((c) => c.method === "saveDrawing")).toHaveLength(0);
  });
});
