import { describe, expect, it } from "vitest";
import { toHardenedXrefInsert } from "../src/tools/domains/xrefParams.js";

/**
 * Two merged PRs each bound the plugin command `attachXref`. Only the hardened implementation
 * survives, so the legacy `filePath`/`overlay` shape is translated. These tests pin the mapping
 * that keeps `acad_attach_xref` and the FASE 1 build working.
 */
describe("legacy xref insert translation", () => {
  it("defaults to a non-cascading overlay, which is this firm's standard", () => {
    const insert = toHardenedXrefInsert({ filePath: "X-TOPO.dwg" });
    expect(insert.command).toBe("overlayXref");
    expect(insert.parameters).toEqual({
      path: "X-TOPO.dwg",
      name: null,
      pathType: "absolute",
      insert: true,
      insertionPoint: { x: 0, y: 0, z: 0 },
      scale: 1,
      rotation: 0,
      layer: null,
    });
  });

  it("selects the cascading attach only when overlay is explicitly false", () => {
    expect(toHardenedXrefInsert({ filePath: "X-TOPO.dwg", overlay: false }).command).toBe("attachXref");
    expect(toHardenedXrefInsert({ filePath: "X-TOPO.dwg", overlay: true }).command).toBe("overlayXref");
  });

  it("carries the insertion point, name, layer, scale and rotation across", () => {
    const insert = toHardenedXrefInsert({
      filePath: "C:\\Proj\\X-UTIL.dwg",
      overlay: false,
      xrefName: "X-UTIL",
      layer: "X-BASE",
      x: 10,
      y: 20,
      z: 30,
      scale: 2,
      rotation: 90,
    });
    expect(insert.command).toBe("attachXref");
    expect(insert.parameters).toMatchObject({
      path: "C:\\Proj\\X-UTIL.dwg",
      name: "X-UTIL",
      insertionPoint: { x: 10, y: 20, z: 30 },
      scale: 2,
      rotation: 90,
      layer: "X-BASE",
    });
  });

  it("keeps a partial insertion point on the Z origin rather than dropping it", () => {
    const insert = toHardenedXrefInsert({ filePath: "X-TOPO.dwg", x: 5, y: 7 });
    expect(insert.parameters.insertionPoint).toEqual({ x: 5, y: 7, z: 0 });
  });
});
