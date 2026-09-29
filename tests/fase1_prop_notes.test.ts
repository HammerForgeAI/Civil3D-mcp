import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_SHEET, isOffSheet, isPropText, stripMText, stripPropNotes } from "../src/tools/domains/fase1PropNotes.js";

// Real contents of the firm's C-300 template MD-WASD notes MText (handle CF80 of the Goulds C-300 template, 2026-09-28).
const CF80 = readFileSync(new URL("./fixtures/md-wasd-notes-cf80.txt", import.meta.url), "utf8");

describe("fase1 PROP notes", () => {
  it("flags PROP/PROPOSED as words only (SUBJECT PROPERTY is existing-conditions wording)", () => {
    expect(isPropText("SUBJECT PROPERTY\\PSINGLE FAMILY RESIDENCE")).toBe(false);
    expect(isPropText("IF PROP. SAN SEWER DEPTH")).toBe(true);
    expect(isPropText("{\\fArial|b1;\\LFOR ALL PROJECTS WHERE REMOVAL OF UTILITY LINES IS PROPOSED}")).toBe(true);
    expect(stripMText("{\\fArial|b1|i0|c0|p34;A\\PB}")).toBe("A B");
  });

  it("strips every PROP bullet and the PROPOSED-activity block from the real template notes, keeping the rest byte-for-byte", () => {
    expect(isPropText(CF80)).toBe(true);
    const result = stripPropNotes(CF80);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(isPropText(result.text)).toBe(false);
    // existing-conditions bullets and the project-specific notes survive
    expect(result.text).toContain("ALL WATER MAIN, WASTEWATER AND STORM SEWER CROSSINGS");
    expect(result.text).toContain("DEFLECTIONS ARE TO BE 2.5 DEG. MAXIMUM.");
    expect(result.text).toContain("PROJECT SPECIFIC NOTES");
    expect(result.text).toContain("CONTRACTOR TO VERIFY BEFORE CONSTRUCTION");
    // the "THE FOLLOWING ACTIVITIES ... FOR PROPOSED ACTIVITY" block goes as a whole
    expect(result.text).not.toContain("THE FOLLOWING ACTIVITIES");
    expect(result.removed.some((r) => r.startsWith("[block]"))).toBe(true);
    expect(result.kept).toBeLessThan(result.total);
    // formatting codes are untouched: the head of the MText is identical
    expect(result.text.slice(0, 120)).toBe(CF80.slice(0, 120));
  });

  it("refuses (changes nothing) when a PROP text is not the MD-WASD notes structure", () => {
    const result = stripPropNotes("{\\fArial|b1|i0|c0|p34;\\LFOR ALL PROJECTS WHERE REMOVAL OF UTILITY LINES IS PROPOSED}");
    expect(result.ok).toBe(false);
  });

  it("tells on-sheet from off-sheet notes on the ARCH D sheet", () => {
    expect(isOffSheet(25.66, 17.923)).toBe(false); // CF80, on the sheet
    expect(isOffSheet(48.315, 16.292)).toBe(true); // CF57, parked beside the title block
    expect(isOffSheet(40.492, 20.16, DEFAULT_SHEET)).toBe(true); // CF75
    expect(isOffSheet(40, 10, { minX: 0, minY: 0, maxX: 48, maxY: 36 })).toBe(false); // bigger sheet via override
  });
});
