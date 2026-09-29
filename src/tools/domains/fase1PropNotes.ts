/**
 * Fase 1 = existing conditions only: no PROP / PROPOSED wording on the sheet (user 2026-09-28). The firm's C-300 template
 * carries the MD-WASD notes as paper-space MText that talk about proposed work. This module holds the ONE copy of the rules
 * used by fase1Audit.ts (detect), fase1Build.ts (fix while building) and the skill script scripts/fase1-strip-prop-notes.mjs
 * (which imports the compiled build/ copy instead of re-implementing it -- see integrity-check.mjs).
 *
 * Rules (validated by hand on VILLA ONE, 2026-09-28):
 *  - a PROP note OUTSIDE the sheet (template scraps parked beside the title block, e.g. CF57/CF6E/CF75 at x 40-64 on an
 *    ARCH D 36x24 sheet) never plots and has no Fase 1 meaning -> erase it;
 *  - a PROP note ON the sheet must be the MD-WASD notes MText -> drop every bullet that says PROP/PROPOSED, and the
 *    "THE FOLLOWING ACTIVITIES ..." block when its closing sentence says PROPOSED (its list has no predicate without it);
 *  - anything else -> refuse (edit by hand); never guess.
 * Pure functions: no MCP/zod imports, unit-tested in tests/fase1_prop_notes.test.ts.
 */

/** Plain text of an MText (formatting codes and braces removed, \P as a space). */
export const stripMText = (value: unknown): string =>
  String(value ?? "").replace(/\\P/g, " ").replace(/\\[A-Za-z][^;\\]*;/g, "").replace(/[{}]/g, "");

/** True when the text says PROP or PROPOSED as a word ("SUBJECT PROPERTY" is NOT a match). */
export const isPropText = (value: unknown): boolean => /\bPROP\b|\bPROPOSED\b/i.test(stripMText(value));

/** Paper-space extents of the sheet, in paper units. */
export interface SheetExtents {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** The firm's C-300 sheet: ARCH D 36" x 24" (template limits -0.39..35.61 x -0.20..23.80), with a small tolerance. */
export const DEFAULT_SHEET: SheetExtents = { minX: -0.5, minY: -0.5, maxX: 36.5, maxY: 24.5 };

export const isOffSheet = (x: number, y: number, sheet: SheetExtents = DEFAULT_SHEET): boolean =>
  x < sheet.minX || x > sheet.maxX || y < sheet.minY || y > sheet.maxY;

export type StripPropNotesResult =
  | { ok: true; text: string; kept: number; total: number; removed: string[] }
  | { ok: false; reason: string };

const BS = "\\";
const BULLET_SEP = `${BS}P${BS}pi0,l0,tz;`; // \P\pi0,l0,tz;
const BULLET_OPEN = `${BS}P${BS}pi-3,l3,t3;`; // \P\pi-3,l3,t3;
const SEP_RE = /\\P\\pi0,l0,tz;\s*\\P\\pi-3,l3,t3;/;
const FOLLOWING = `${BS}P${BS}pi0,l0,tz;${BS}P${BS}fArial|b1|i0|c0|p34;${BS}H1.4x;${BS}LTHE FOLLOWING ACTIVITIES`;
const SPECIFIC = `${BS}P${BS}P${BS}P${BS}fArial|b1|i0|c0|p34;${BS}H1.39998x;${BS}LPROJECT SPECIFIC NOTES`;
const plain = (t: string): string => stripMText(t).replace(/\s+/g, " ").trim();

/**
 * Removes from the MD-WASD notes MText (raw contents, as listTextEntities returns them) every bullet / block that says PROP
 * or PROPOSED. Returns ok:false (and changes nothing) when the text is not that structure or still says PROP afterwards.
 */
export function stripPropNotes(raw: string): StripPropNotesResult {
  const headMark = raw.indexOf(BULLET_OPEN);
  const secEnd = raw.indexOf(FOLLOWING);
  const specificAt = raw.indexOf(SPECIFIC);
  if (headMark < 0 || secEnd < 0 || specificAt < 0 || !(headMark < secEnd && secEnd < specificAt)) {
    return {
      ok: false,
      reason: "unrecognized MText structure (expected head, bullets, 'THE FOLLOWING ACTIVITIES', 'PROJECT SPECIFIC NOTES') -- edit by hand",
    };
  }

  const head = raw.slice(0, headMark + BULLET_OPEN.length);
  const bulletsRaw = raw.slice(headMark + BULLET_OPEN.length, secEnd);
  const block = raw.slice(secEnd, specificAt);
  const tail = raw.slice(specificAt);

  const items = bulletsRaw.split(SEP_RE);
  const removed: string[] = [];
  const kept = items.filter((item) => {
    if (isPropText(item)) {
      removed.push(plain(item));
      return false;
    }
    return true;
  });
  let text = head + kept.join(BULLET_SEP + BULLET_OPEN);
  if (isPropText(block)) {
    removed.push(`[block] ${plain(block).slice(0, 110)}…`);
  } else {
    text += block;
  }
  text += tail;

  if (isPropText(text)) {
    const where = plain(text).match(/.{0,40}\bPROP(OSED)?\b.{0,40}/i)?.[0] ?? "";
    return { ok: false, reason: `still says PROP/PROPOSED after the transform (unexpected place): ${where}` };
  }
  return { ok: true, text, kept: kept.length, total: items.length, removed };
}
