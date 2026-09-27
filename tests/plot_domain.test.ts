import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { sendCommandMock } = vi.hoisted(() => ({
  sendCommandMock: vi.fn(),
}));

vi.mock("../src/utils/ConnectionManager.js", () => ({
  withApplicationConnection: async <T>(
    operation: (client: { sendCommand: typeof sendCommandMock }) => Promise<T>,
  ) => await operation({
    sendCommand: sendCommandMock,
  }),
}));

import {
  PLOT_DOMAIN_DEFINITION,
  PlotLayoutsToPdfArgsSchema,
  PublishSheetSetArgsSchema,
} from "../src/tools/domains/plotDomain.js";
import { JOB_DOMAIN_DEFINITION } from "../src/tools/domains/jobDomain.js";
import { isApprovalRequired } from "../src/tools/approvalPolicy.js";
import { GENERATED_TOOL_CATALOG_ENTRIES, findManifestAction } from "../src/tools/toolManifest.js";

const pluginSource = (fileName: string) =>
  readFileSync(new URL(`../Civil3D-MCP-Plugin/${fileName}`, import.meta.url), "utf8");

// C# source with comments and string literals removed, so guards match code
// only (the file documents why it avoids PlotEngine in comments).
const pluginCode = (fileName: string) =>
  pluginSource(fileName)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "")
    .replace(/@?\$?"(?:[^"\\\r\n]|\\.)*"/g, '""');

function approvalTargetFor(action: string) {
  const match = findManifestAction("civil3d_plot", action);
  expect(match, `civil3d_plot action ${action} is registered`).toBeDefined();
  return {
    toolName: "civil3d_plot",
    action,
    capabilities: match!.actionDefinition.capabilities,
    safeForRetry: match!.actionDefinition.safeForRetry,
    requiresActiveDrawing: match!.actionDefinition.requiresActiveDrawing,
  };
}

describe("civil3d_plot schemas", () => {
  it("accepts a layout list or allLayouts with exactly one output target", () => {
    expect(PlotLayoutsToPdfArgsSchema.safeParse({
      action: "plot_layouts_to_pdf",
      layoutNames: ["C-101", "C-102"],
      outputDirectory: "C:/Users/me/Documents/plots",
    }).success).toBe(true);
    expect(PlotLayoutsToPdfArgsSchema.safeParse({
      action: "plot_layouts_to_pdf",
      allLayouts: true,
      outputDirectory: "C:/Users/me/Documents/plots",
      pageSetup: "PDF-ANSI-D",
      plotStyleTable: "monochrome.ctb",
      orientation: "landscape",
    }).success).toBe(true);
    expect(PlotLayoutsToPdfArgsSchema.safeParse({
      action: "plot_layouts_to_pdf",
      layoutNames: ["C-101"],
      outputPath: "C:/Users/me/Documents/C-101.pdf",
    }).success).toBe(true);
  });

  it("rejects ambiguous layout selection and output targets", () => {
    const invalid = [
      { layoutNames: ["C-101"], allLayouts: true, outputDirectory: "C:/out" },
      { outputDirectory: "C:/out" },
      { layoutNames: [], outputDirectory: "C:/out" },
      { layoutNames: ["C-101"] },
      { layoutNames: ["C-101"], outputDirectory: "C:/out", outputPath: "C:/out/a.pdf" },
      { layoutNames: ["C-101", "C-102"], outputPath: "C:/out/a.pdf" },
      { allLayouts: true, outputPath: "C:/out/a.pdf" },
      { layoutNames: ["C-101"], outputPath: "C:/out/a.dwg" },
      { layoutNames: ["C-101"], outputDirectory: "C:/out", orientation: "sideways" },
      // Whitespace-only overrides would be ignored by the plugin.
      { layoutNames: ["C-101"], outputDirectory: "C:/out", pageSetup: "   " },
      { layoutNames: ["C-101"], outputDirectory: "C:/out", paperSize: " " },
      { layoutNames: ["C-101"], outputDirectory: "C:/out", plotStyleTable: "\t" },
    ];
    for (const args of invalid) {
      expect(
        PlotLayoutsToPdfArgsSchema.safeParse({ action: "plot_layouts_to_pdf", ...args }).success,
        JSON.stringify(args),
      ).toBe(false);
    }
    const listPlotters = PLOT_DOMAIN_DEFINITION.actions.list_plotters.inputSchema;
    expect(listPlotters.safeParse({ action: "list_plotters", device: "DWG To PDF.pc3" }).success).toBe(true);
    expect(listPlotters.safeParse({ action: "list_plotters", device: "  " }).success).toBe(false);
  });

  it("validates publish_sheet_set sheet lists and the PDF output path", () => {
    expect(PublishSheetSetArgsSchema.safeParse({
      action: "publish_sheet_set",
      outputPath: "C:/Users/me/Documents/set.pdf",
    }).success).toBe(true);
    expect(PublishSheetSetArgsSchema.safeParse({
      action: "publish_sheet_set",
      outputPath: "C:/Users/me/Documents/set.PDF",
      sheets: [{ layoutName: "C-101" }, { layoutName: "C-201", drawingPath: "C:/Users/me/Documents/other.dwg" }],
    }).success).toBe(true);
    expect(PublishSheetSetArgsSchema.safeParse({
      action: "publish_sheet_set",
      outputPath: "C:/Users/me/Documents/set.dwf",
    }).success).toBe(false);
    expect(PublishSheetSetArgsSchema.safeParse({
      action: "publish_sheet_set",
      outputPath: "C:/Users/me/Documents/set.pdf",
      layoutNames: ["C-101"],
      sheets: [{ layoutName: "C-102" }],
    }).success).toBe(false);
    expect(PublishSheetSetArgsSchema.safeParse({
      action: "publish_sheet_set",
      outputPath: "C:/Users/me/Documents/set.pdf",
      sheets: [{ drawingPath: "C:/x.dwg" }],
    }).success).toBe(false);
  });
});

describe("civil3d_plot policy classification", () => {
  it("never gates the read-only discovery actions", () => {
    for (const action of ["list_layouts", "list_page_setups", "list_plotters"]) {
      const target = approvalTargetFor(action);
      expect(target.capabilities).toEqual(["query", "inspect"]);
      expect(target.safeForRetry).toBe(true);
      expect(isApprovalRequired(target)).toBe(false);
    }
  });

  it("gates both file-producing actions behind approval and marks them non-retryable", () => {
    for (const action of ["plot_layouts_to_pdf", "publish_sheet_set"]) {
      const target = approvalTargetFor(action);
      expect(target.capabilities).toContain("export");
      expect(target.safeForRetry).toBe(false);
      expect(target.requiresActiveDrawing).toBe(true);
      expect(isApprovalRequired(target)).toBe(true);
    }
  });

  it("publishes a single canonical civil3d_plot catalog entry", () => {
    const entry = GENERATED_TOOL_CATALOG_ENTRIES.find((candidate) => candidate.toolName === "civil3d_plot");
    expect(entry).toBeDefined();
    expect(entry!.domain).toBe("plot");
    expect(entry!.safeForRetry).toBe(false);
    expect(entry!.requiresActiveDrawing).toBe(true);
    expect(entry!.pluginMethods).toEqual(expect.arrayContaining([
      "plotListLayouts",
      "plotListPageSetups",
      "plotListPlotters",
      "plotLayoutsToPdf",
      "plotPublishSheetSet",
    ]));
  });

  it("exposes plot jobs through civil3d_job, which is itself approval-gated", () => {
    const start = JOB_DOMAIN_DEFINITION.actions.start;
    expect(start.inputSchema.safeParse({
      action: "start",
      operation: "plot_layouts_to_pdf",
      parameters: { allLayouts: true, outputDirectory: "C:/out" },
    }).success).toBe(true);
    expect(start.inputSchema.safeParse({
      action: "start",
      operation: "publish_sheet_set",
      parameters: { outputPath: "C:/out/set.pdf" },
    }).success).toBe(true);
    expect(isApprovalRequired({
      toolName: "civil3d_job",
      action: "start",
      capabilities: start.capabilities,
      safeForRetry: start.safeForRetry,
    })).toBe(true);

    const jobs = pluginSource("JobCommands.cs");
    expect(jobs).toContain('["plot_layouts_to_pdf"] = "plotLayoutsToPdf"');
    expect(jobs).toContain('["publish_sheet_set"] = "plotPublishSheetSet"');
  });
});

describe("civil3d_plot routing", () => {
  beforeEach(() => {
    sendCommandMock.mockReset();
  });

  it("sends plot_layouts_to_pdf to the plugin with safe defaults", async () => {
    sendCommandMock.mockResolvedValue({ plotted: 1 });
    const args = PlotLayoutsToPdfArgsSchema.parse({
      action: "plot_layouts_to_pdf",
      layoutNames: ["C-101"],
      outputDirectory: "C:/out",
    });
    await PLOT_DOMAIN_DEFINITION.actions.plot_layouts_to_pdf.execute(args);

    expect(sendCommandMock).toHaveBeenCalledWith("plotLayoutsToPdf", expect.objectContaining({
      layoutNames: ["C-101"],
      allLayouts: false,
      outputDirectory: "C:/out",
      overwrite: false,
      continueOnError: true,
    }));
  });

  it("starts a job instead when asJob is set", async () => {
    sendCommandMock.mockResolvedValue({ jobId: "abc", state: "running", operation: "publish_sheet_set" });
    const args = PublishSheetSetArgsSchema.parse({
      action: "publish_sheet_set",
      outputPath: "C:/out/set.pdf",
      layoutNames: ["C-101", "C-102"],
      asJob: true,
    });
    const result = await PLOT_DOMAIN_DEFINITION.actions.publish_sheet_set.execute(args);

    expect(sendCommandMock).toHaveBeenCalledWith("startJob", {
      operation: "publish_sheet_set",
      parameters: {
        outputPath: "C:/out/set.pdf",
        layoutNames: ["C-101", "C-102"],
        sheets: undefined,
        overwrite: false,
        requireSaved: true,
        keepDsd: false,
      },
    });
    expect(PLOT_DOMAIN_DEFINITION.actions.publish_sheet_set.responseSchema!.safeParse(result).success).toBe(true);
  });

  it("validates a structured per-layout plot result", () => {
    const response = {
      device: "DWG To PDF.pc3",
      method: "-PLOT (BACKGROUNDPLOT=0)",
      requested: 2,
      plotted: 1,
      failed: 1,
      skipped: 0,
      totalBytes: 48213,
      durationMs: 5120,
      layouts: [
        {
          layoutName: "C-101", status: "plotted", outputPath: "C:/out/site-C-101.pdf", bytes: 48213, pageCount: 1,
          paperSize: "ANSI D (34.00 x 22.00 Inches)", orientation: "landscape", plotStyleTable: "monochrome.ctb",
          pageSetup: null, durationMs: 4100, error: null,
        },
        {
          layoutName: "C-102", status: "failed", outputPath: "C:/out/site-C-102.pdf", bytes: null, pageCount: null,
          paperSize: "ANSI D (34.00 x 22.00 Inches)", orientation: "landscape", plotStyleTable: null,
          pageSetup: null, durationMs: 1000, error: "The plot command finished but no PDF was written.",
        },
      ],
      warnings: ["1 of 2 layouts were not plotted; see per-layout status."],
    };
    expect(PLOT_DOMAIN_DEFINITION.actions.plot_layouts_to_pdf.responseSchema!.safeParse(response).success).toBe(true);
  });
});

describe("civil3d_plot native implementation guards", () => {
  it("drives -PLOT/-PUBLISH in the foreground instead of the crash-prone PlotEngine", () => {
    const source = pluginSource("PlotCommands.cs");
    expect(source).toContain('"_.-PLOT"');
    expect(source).toContain('"_.-PUBLISH"');
    expect(source).toContain('sysvars.Set("BACKGROUNDPLOT", 0)');
    expect(source).toContain('sysvars.Set("FILEDIA", 0)');
    expect(source).toContain("CommandLineRunner.RunAsync(");
    expect(source).toContain("CivilExecution.ExecuteCommandSequenceAsync<object?>(");
    // Any use of the plot API in code, however qualified or spaced, fails the
    // guard; the comments explaining the decision do not.
    const code = pluginCode("PlotCommands.cs");
    expect(code).toContain("PlotSettingsValidator.Current");
    expect(code).not.toMatch(/\b(?:PlotFactory|PlotEngine|BackgroundPlotEngine|PreviewEngine|SetPlotCentered)\b/);
  });

  it("lets the plotter write only to a staged temp file that is renamed into place", () => {
    const source = pluginSource("PlotCommands.cs");
    const boundary = pluginSource("FileBoundary.cs");
    expect(source).toContain("FileBoundary.BeginExternalWrite(job.OutputPath!, overwrite)");
    expect(source).toContain("FileBoundary.BeginExternalWrite(outputPath, overwrite)");
    expect(source).toContain("output.TempPath,              // File name");
    expect(source).toContain("BuildDsd(sheets, currentPath, output.TempPath)");
    expect(source).not.toContain("LockExportDirectoryForExternalWriter");
    expect(boundary).toContain("File.Move(TempPath, FinalPath, _overwrite)");
    expect(boundary).toContain("FileAttributes.ReparsePoint | FileAttributes.Directory");
  });

  it("refuses to feed a new command into a prompt an earlier request left open", () => {
    const runner = pluginSource("CommandLineRunner.cs");
    const run = runner.slice(runner.indexOf("internal static async Task RunAsync"));
    const staleCheck = run.indexOf("FindActiveCommand(DrivenCommandsSnapshot())");
    expect(staleCheck).toBeGreaterThan(-1);
    expect(staleCheck).toBeLessThan(run.indexOf("await doc.Editor.CommandAsync(tokens)"));
    expect(run.indexOf("FindActiveCommand([commandName])")).toBeGreaterThan(run.indexOf("await doc.Editor.CommandAsync(tokens)"));
  });

  it("skips or rejects never-initialized layouts before publishing", () => {
    const source = pluginSource("PlotCommands.cs");
    expect(source).toContain("layout.GetViewports().Count > 0");
    expect(source).toContain("currentLayouts.Where(layout => layout.Initialized)");
    expect(source.match(/RequireInitialized\(match\);/g)?.length).toBe(2);
  });

  it("routes every output path through FileBoundary and fails fast without a document", () => {
    const source = pluginSource("PlotCommands.cs");
    expect(source).toContain('FileBoundary.ResolveExportPath(raw, overwrite, ".pdf")');
    expect(source).toContain('FileBoundary.ResolveExportPath(outputPathRaw, overwrite, ".pdf")');
    expect(source).toContain('FileBoundary.ResolveImportPath(drawingPath, ".dwg")');
    expect(source).toContain("FileBoundary.WriteAllTextAtomic(dsdPath");

    const execution = pluginSource("CivilExecution.CommandSequence.cs");
    const sequence = execution.slice(execution.indexOf("ExecuteCommandSequenceAsync"));
    expect(sequence.indexOf("CIVIL3D.NO_DRAWING")).toBeGreaterThan(-1);
    expect(sequence.indexOf("CIVIL3D.NO_DRAWING")).toBeLessThan(sequence.indexOf("DocumentManager.ExecuteInCommandContextAsync"));
  });
});
