/**
 * The single source of truth for what the optional plan-vision service needs. The pins in
 * plan-vision/requirements.txt are locked to these exact versions by
 * tests/plan_vision_service.test.ts, so a version bump cannot land in one place only.
 *
 * Tesseract is a system binary, not a pip package. It is listed here so the preflight and the
 * error message can name it, but it is never installed by pip.
 */

export type PlanVisionPipPackage = {
  /** The PyPI project name, exactly as requirements.txt pins it. */
  name: string;
  /** The module name the preflight imports. These differ for PyMuPDF. */
  importName: string;
  /** The exact release pinned in plan-vision/requirements.txt. */
  pin: string;
};

export const MINIMUM_PYTHON_VERSION = "3.10";

export const PIP_PACKAGES: readonly PlanVisionPipPackage[] = [
  { name: "opencv-python", importName: "cv2", pin: "4.10.0.84" },
  { name: "pytesseract", importName: "pytesseract", pin: "0.3.13" },
  { name: "pymupdf", importName: "pymupdf", pin: "1.24.11" },
  { name: "pillow", importName: "PIL", pin: "11.0.0" },
  { name: "numpy", importName: "numpy", pin: "2.1.3" },
];

export const SYSTEM_BINARY = "tesseract";

/** Turns the preflight's module names back into the PyPI names a reader can install. */
export function describeMissingPackages(importNames: readonly string[]): string {
  return importNames
    .map((importName) => {
      const entry = PIP_PACKAGES.find((candidate) => candidate.importName === importName);
      return entry ? `${entry.name}==${entry.pin}` : importName;
    })
    .join(", ");
}
