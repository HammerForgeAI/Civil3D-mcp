import { describe, expect, it } from "vitest";
import { runFase1Audit, summarizeFase1, type PluginSend } from "../src/tools/domains/fase1Audit.js";

type Responses = Record<string, unknown | Error>;

function fakePlugin(responses: Responses): PluginSend {
  return async (method, params) => {
    const key = method === "getAlignment" ? `getAlignment:${String(params.name)}` : method;
    if (!(key in responses)) {
      throw new Error(`unexpected plugin call ${key}`);
    }
    const value = responses[key];
    if (value instanceof Error) {
      throw value;
    }
    return value;
  };
}

const cleanDrawing: Responses = {
  listLayouts: { layouts: [{ name: "Model" }, { name: "C-300" }] },
  listTextEntities: { entities: [
    { space: "model", handle: "A1", text: "SW 118TH AVENUE" },
    { space: "paper", layout: "C-300", handle: "B2", text: "SUBJECT PROPERTY\\PSINGLE FAMILY RESIDENCE" },
  ] },
  listPressureNetworks: { networks: [] },
  profileViewInfo: { profileViews: [] },
  listPipeNetworks: { networks: [] },
  listAlignments: { alignments: [{ name: "SW 118TH AVE" }] },
  "getAlignment:SW 118TH AVE": { style: "BCC - ALIGNMENT" },
  listSurfaces: { surfaces: [{ name: "EG" }] },
  listLayers: { layers: [{ name: "C-TINN-BNDY", isFrozen: true, isOff: false }] },
};

const level = (checks: Awaited<ReturnType<typeof runFase1Audit>>, what: string) => checks.find((c) => c.what === what)?.level;

describe("fase1 audit", () => {
  it("passes a clean fase 1 drawing (SUBJECT PROPERTY is not a PROP hit)", async () => {
    const checks = await runFase1Audit(fakePlugin(cleanDrawing));
    expect(checks.filter((c) => c.level === "FAIL")).toEqual([]);
    expect(summarizeFase1(checks).fail).toBe(0);
    expect(level(checks, "surface boundary")).toBe("OK");
    expect(level(checks, "alignment SW 118TH AVE")).toBe("OK");
  });

  it("fails every design leftover and names the fix", async () => {
    const dirty: Responses = {
      ...cleanDrawing,
      listLayouts: { layouts: [{ name: "Model" }, { name: "C-300" }, { name: "C-301" }] },
      listTextEntities: { entities: [
        { space: "model", handle: "C1", text: "PROP 23 LF OF 6\" PVC" },
        { space: "paper", layout: "C-300", handle: "C2", text: "\\pxqc;THE PROPOSED ACTIVITY" },
      ] },
      listPressureNetworks: { networks: [{ name: "PROP WATER MAIN" }] },
      profileViewInfo: { profileViews: [{ profileViewName: "PV-1" }] },
      listPipeNetworks: { networks: [{ name: "PROP SAN SEWER" }] },
      "getAlignment:SW 118TH AVE": { style: "Intersection Basic" },
      listLayers: { layers: [{ name: "C-TINN-BNDY", isFrozen: false, isOff: false }] },
    };
    const checks = await runFase1Audit(fakePlugin(dirty));
    const failed = checks.filter((c) => c.level === "FAIL").map((c) => c.what);
    expect(failed).toEqual(expect.arrayContaining([
      "layouts",
      "PROP text in Model",
      "PROP/PROPOSED wording in paper space",
      "pressure networks",
      "profile views",
      "gravity pipe networks",
      "alignment SW 118TH AVE",
      "surface boundary",
    ]));
    expect(checks.find((c) => c.what === "alignment SW 118TH AVE")!.detail).toContain("set_style");
    expect(checks.find((c) => c.what === "surface boundary")!.detail).toContain("frozen:true");
  });

  it("degrades to WARN when a query fails (old DLL without listLayers, empty gravity shell)", async () => {
    const degraded: Responses = {
      ...cleanDrawing,
      listPipeNetworks: new Error("Retrieve attribute failed"),
      listLayers: new Error("Plugin method 'listLayers' is not implemented yet"),
    };
    const checks = await runFase1Audit(fakePlugin(degraded));
    expect(level(checks, "gravity pipe networks")).toBe("WARN");
    expect(level(checks, "surface boundary")).toBe("WARN");
    expect(checks.some((c) => c.level === "FAIL")).toBe(false);
  });

  it("honours a custom alignment style and boundary layer", async () => {
    const checks = await runFase1Audit(fakePlugin({
      ...cleanDrawing,
      listLayers: { layers: [{ name: "X-BNDY", isFrozen: false, isOff: true }] },
    }), { alignmentStyle: "bcc - alignment", boundaryLayer: "X-BNDY" });
    expect(level(checks, "alignment SW 118TH AVE")).toBe("OK");
    expect(level(checks, "surface boundary")).toBe("OK");
  });
});
