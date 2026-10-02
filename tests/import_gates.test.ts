import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ImportPathRefusedError,
  configuredImportRoots,
  isWithinRoot,
  resolveGatedImportPath,
} from "../src/tools/importGate.js";
import { runFase1Build, type PluginSend } from "../src/tools/domains/fase1Build.js";

/**
 * Item 19 -- refusal and closure gates on the import paths.
 *
 * Two rules are pinned here, at the shared helper and at the real call site in the FASE 1 build:
 *   1. a path that is not inside the configured import roots is refused;
 *   2. a file whose extension the action does not allow is refused;
 * and in both cases the command must never reach the plugin.
 */

const ROOT = path.join(os.tmpdir(), "c3d-import-roots");
const OUTSIDE = path.join(os.tmpdir(), "c3d-elsewhere");
const allowed = { CIVIL3D_IMPORT_ROOTS: ROOT };

const previousImportRoots = process.env.CIVIL3D_IMPORT_ROOTS;
const previousFileRoots = process.env.CIVIL3D_FILE_ROOTS;

beforeEach(() => {
  delete process.env.CIVIL3D_IMPORT_ROOTS;
  delete process.env.CIVIL3D_FILE_ROOTS;
});

afterEach(() => {
  if (previousImportRoots === undefined) delete process.env.CIVIL3D_IMPORT_ROOTS;
  else process.env.CIVIL3D_IMPORT_ROOTS = previousImportRoots;
  if (previousFileRoots === undefined) delete process.env.CIVIL3D_FILE_ROOTS;
  else process.env.CIVIL3D_FILE_ROOTS = previousFileRoots;
});

function refusal(run: () => unknown): ImportPathRefusedError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ImportPathRefusedError);
    return error as ImportPathRefusedError;
  }
  throw new Error("expected the import gate to refuse the path");
}

describe("import gate: configured roots", () => {
  it("reads CIVIL3D_IMPORT_ROOTS first and CIVIL3D_FILE_ROOTS as the shared fallback", () => {
    expect(configuredImportRoots({ CIVIL3D_IMPORT_ROOTS: ROOT })).toEqual([ROOT]);
    expect(configuredImportRoots({ CIVIL3D_FILE_ROOTS: OUTSIDE })).toEqual([OUTSIDE]);
    expect(configuredImportRoots({ CIVIL3D_IMPORT_ROOTS: ROOT, CIVIL3D_FILE_ROOTS: OUTSIDE })).toEqual([ROOT]);
    expect(configuredImportRoots({ CIVIL3D_IMPORT_ROOTS: "   " })).toEqual([]);
    expect(configuredImportRoots({})).toEqual([]);
  });

  it("splits several roots on the platform path delimiter, like Path.PathSeparator", () => {
    expect(configuredImportRoots({ CIVIL3D_IMPORT_ROOTS: [ROOT, OUTSIDE].join(path.delimiter) }))
      .toEqual([ROOT, OUTSIDE]);
  });

  it("does not treat a sibling folder that merely shares the root prefix as inside it", () => {
    expect(isWithinRoot(path.join(ROOT, "X-TOPO.dwg"), ROOT)).toBe(true);
    expect(isWithinRoot(ROOT, ROOT)).toBe(true);
    expect(isWithinRoot(path.join(`${ROOT}-other`, "X-TOPO.dwg"), ROOT)).toBe(false);
    expect(isWithinRoot(OUTSIDE, ROOT)).toBe(false);
  });
});

describe("import gate: refusal 1 -- outside the configured import roots", () => {
  it("refuses a path outside the roots with the plugin's own error code", () => {
    const error = refusal(() => resolveGatedImportPath(path.join(OUTSIDE, "X-TOPO.dwg"), [".dwg"], allowed));

    expect(error.code).toBe("CIVIL3D.PATH_NOT_ALLOWED");
    expect(error.message).toContain("outside the configured roots");
    expect(error.refusedPath).toBe(path.join(OUTSIDE, "X-TOPO.dwg"));
  });

  it("refuses a path that climbs out of the roots with ..", () => {
    const escape = `${ROOT}${path.sep}..${path.sep}c3d-elsewhere${path.sep}X-TOPO.dwg`;
    const error = refusal(() => resolveGatedImportPath(escape, [".dwg"], allowed));

    expect(error.code).toBe("CIVIL3D.PATH_NOT_ALLOWED");
  });

  it("requires an absolute path once a root is configured", () => {
    const error = refusal(() => resolveGatedImportPath("X-TOPO.dwg", [".dwg"], allowed));

    expect(error.code).toBe("CIVIL3D.INVALID_INPUT");
    expect(error.message).toContain("must be absolute");
  });

  it("accepts a path inside the roots and returns its canonical form", () => {
    const inside = path.join(ROOT, "X-TOPO.dwg");
    expect(resolveGatedImportPath(inside, [".dwg"], allowed)).toBe(path.resolve(inside));
  });

  it("passes the caller's string through unchanged when no root is configured, where the plugin's own boundary rules", () => {
    // The plugin falls back to the user's Documents folder; Node must not invent a stricter rule
    // than the boundary it is fronting for.
    expect(resolveGatedImportPath("X-TOPO.dwg", [".dwg"], {})).toBe("X-TOPO.dwg");
  });
});

describe("import gate: refusal 2 -- extension the action does not allow", () => {
  it("refuses a file whose extension the action does not allow", () => {
    const error = refusal(() => resolveGatedImportPath(path.join(ROOT, "field-notes.txt"), [".dwg"], allowed));

    expect(error.code).toBe("CIVIL3D.FILE_TYPE_NOT_ALLOWED");
    expect(error.message).toContain("Extension '.txt' is not allowed");
    expect(error.message).toContain(".dwg");
  });

  it("applies the extension rule with no root configured too, and is case-insensitive", () => {
    expect(refusal(() => resolveGatedImportPath("notes.txt", [".dwg"], {}))).toBeInstanceOf(ImportPathRefusedError);
    expect(resolveGatedImportPath("X-TOPO.DWG", [".dwg"], {})).toBe("X-TOPO.DWG");
    expect(resolveGatedImportPath("X-TOPO.dwg", ["dwg"], {})).toBe("X-TOPO.dwg");
  });

  it("refuses a nameless file under a root that has no extension at all", () => {
    expect(refusal(() => resolveGatedImportPath(path.join(ROOT, "X-TOPO"), [".dwg"], allowed)).code)
      .toBe("CIVIL3D.FILE_TYPE_NOT_ALLOWED");
  });
});

describe("import gate at the FASE 1 build call sites", () => {
  type Call = { method: string; params: Record<string, unknown> };

  const fakePlugin = (log: Call[]): PluginSend => async (method, params) => {
    log.push({ method, params });
    if (method === "listOpenDocuments") {
      return { documents: [{ name: "PROJECT FASE 1.dwg", filePath: "C:/Proj/PROJECT FASE 1.dwg", isActive: true }] };
    }
    return {};
  };

  it("refuses an xref outside the import roots before any xref command reaches the plugin", async () => {
    process.env.CIVIL3D_IMPORT_ROOTS = ROOT;
    const log: Call[] = [];

    const steps = await runFase1Build(fakePlugin(log), {
      expectedDocument: "PROJECT FASE 1.dwg",
      xrefs: [{ filePath: path.join(OUTSIDE, "X-TOPO.dwg") }],
      save: false,
    });

    expect(log.some((c) => c.method === "overlayXref" || c.method === "attachXref")).toBe(false);
    const step = steps.find((s) => s.name.startsWith("xref"))!;
    expect(step.status).toBe("FAIL");
    expect(step.detail).toContain("outside the configured roots");
  });

  it("refuses an xref whose extension the action does not allow", async () => {
    process.env.CIVIL3D_IMPORT_ROOTS = ROOT;
    const log: Call[] = [];

    const steps = await runFase1Build(fakePlugin(log), {
      expectedDocument: "PROJECT FASE 1.dwg",
      xrefs: [{ filePath: path.join(ROOT, "X-TOPO.txt") }],
      save: false,
    });

    expect(log.some((c) => c.method === "overlayXref" || c.method === "attachXref")).toBe(false);
    expect(steps.find((s) => s.name.startsWith("xref"))!.detail).toContain("is not allowed");
  });

  it("still imports an xref that is inside the roots with an allowed extension", async () => {
    process.env.CIVIL3D_IMPORT_ROOTS = ROOT;
    const log: Call[] = [];

    await runFase1Build(fakePlugin(log), {
      expectedDocument: "PROJECT FASE 1.dwg",
      xrefs: [{ filePath: path.join(ROOT, "X-TOPO.dwg") }],
      save: false,
    });

    const sent = log.find((c) => c.method === "overlayXref")!;
    expect(sent.params.path).toBe(path.join(ROOT, "X-TOPO.dwg"));
  });

  it("refuses a template drawing outside the import roots before newDrawing reaches the plugin", async () => {
    process.env.CIVIL3D_IMPORT_ROOTS = ROOT;
    const log: Call[] = [];

    const steps = await runFase1Build(fakePlugin(log), {
      templatePath: path.join(OUTSIDE, "C-300 template.dwg"),
      expectedDocument: "PROJECT FASE 1.dwg",
      save: false,
    });

    expect(log.some((c) => c.method === "newDrawing")).toBe(false);
    expect(steps.find((s) => s.name === "open template")!.detail).toContain("outside the configured roots");
  });

  it("refuses a block definition outside the import roots and keeps the refused copy out of the batch", async () => {
    process.env.CIVIL3D_IMPORT_ROOTS = ROOT;
    const log: Call[] = [];

    const steps = await runFase1Build(fakePlugin(log), {
      expectedDocument: "PROJECT FASE 1.dwg",
      clImport: { blockName: "_cl", sourceFilePath: path.join(OUTSIDE, "X-TOPO.dwg") },
      entities: [
        { kind: "block", blockName: "_cl", x: 10, y: 20 },
        { kind: "mtext", text: "SW 118TH AVENUE" },
      ],
      save: false,
    });

    expect(log.some((c) => c.method === "insertBlockReference")).toBe(false);
    expect(steps.find((s) => s.name === "import block \"_cl\"")!.status).toBe("FAIL");
    // a refused source cannot define the block, so the copy it belonged to is not batched either
    expect(log.some((c) => c.method === "createEntities")).toBe(false);
  });
});
