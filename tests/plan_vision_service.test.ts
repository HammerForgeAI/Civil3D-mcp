import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MINIMUM_PYTHON_VERSION, PIP_PACKAGES, SYSTEM_BINARY, describeMissingPackages } from "../src/utils/planVisionRequirements.js";
import { planVisionCliPath, planVisionRequirementsPath, planVisionServiceDirectory } from "../src/utils/PlanVisionBridge.js";

/**
 * Item 9 ships only if the Python side is pinned, declared and OPTIONAL. These tests hold the pins
 * (one exact release per package, no ranges), hold the service files at the repository root, and
 * hold the CLI's declared command set. The Python code itself cannot run on this host, so a syntax
 * check is the strongest claim made here.
 */

const serviceDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "plan-vision",
);

function readRequirements(): Map<string, string> {
  const lines = readFileSync(planVisionRequirementsPath(), "utf8").split(/\r?\n/);
  const pins = new Map<string, string>();
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const match = /^([A-Za-z0-9._-]+)\s*==\s*([A-Za-z0-9._+-]+)$/.exec(trimmed);
    expect(match, `requirements line is not an exact pin: '${trimmed}'`).not.toBeNull();
    pins.set(match![1].toLowerCase(), match![2]);
  }
  return pins;
}

describe("plan-vision pinned requirements", () => {
  it("resolves the service directory that holds the CLI and the pinned list", () => {
    expect(planVisionServiceDirectory()).toBe(serviceDirectory);
    expect(existsSync(planVisionCliPath())).toBe(true);
    expect(existsSync(planVisionRequirementsPath())).toBe(true);
  });

  it("pins every package to one exact release, with no range operator", () => {
    const pins = readRequirements();
    expect(pins.size).toBe(PIP_PACKAGES.length);
    for (const entry of PIP_PACKAGES) {
      expect(pins.get(entry.name)).toBe(entry.pin);
    }
  });

  it("matches the declarations in planVisionRequirements.ts", () => {
    const pins = readRequirements();
    expect([...pins.keys()].sort()).toEqual(PIP_PACKAGES.map((entry) => entry.name).sort());
  });

  it("names Tesseract as a system binary and not as a pip package", () => {
    const raw = readFileSync(planVisionRequirementsPath(), "utf8");
    expect(raw).toContain("Tesseract is a system binary");
    expect(raw).not.toMatch(/^tesseract\s*==/m);
    expect(SYSTEM_BINARY).toBe("tesseract");
  });

  it("reports a missing module back as the installable package", () => {
    expect(describeMissingPackages(["cv2", "pymupdf"])).toBe("opencv-python==4.10.0.84, pymupdf==1.24.11");
    expect(MINIMUM_PYTHON_VERSION).toBe("3.10");
  });
});

describe("plan-vision service files", () => {
  it("ships the CLI and every module the CLI imports", () => {
    const modules = readdirSync(path.join(serviceDirectory, "plan_vision")).filter((name) => name.endsWith(".py"));
    expect(modules.sort()).toEqual([
      "__init__.py",
      "detect.py",
      "legend.py",
      "ocr.py",
      "rasterize.py",
      "templates.py",
      "text_layout.py",
    ]);
  });

  it("declares the five commands the domain dispatches to", () => {
    const cli = readFileSync(planVisionCliPath(), "utf8");
    for (const command of [
      "rasterize_pdf_page",
      "extract_legend_templates",
      "train_symbol_template",
      "detect_symbols_cv",
      "ocr_extract_labels",
    ]) {
      expect(cli).toContain(`"${command}"`);
    }
    expect(cli).not.toContain("calibrate_scale_from_dimension");
  });

  it("still parses as Python, when a Python 3 interpreter is present on this host", () => {
    const interpreter = ["python3", "python"].find((candidate) => isOnPath(candidate));
    if (!interpreter) return; // No interpreter on this host. No pass is claimed for the Python syntax.

    // compileall writes __pycache__ directories. Compile a copy in a temporary directory so the
    // repository tree stays exactly as committed.
    const scratch = mkdtempSync(path.join(tmpdir(), "plan-vision-compile-"));
    try {
      cpSync(serviceDirectory, scratch, { recursive: true });
      execFileSync(interpreter, ["-m", "compileall", "-q", scratch], { stdio: "pipe" });
    } catch (error) {
      const failure = error as NodeJS.ErrnoException & { stderr?: Buffer };
      throw new Error(`plan-vision Python files do not compile: ${failure.stderr?.toString() ?? failure.message}`);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
    expect(readdirSync(serviceDirectory).sort()).toEqual(["README.md", "cli.py", "plan_vision", "requirements.txt"]);
  });
});

function isOnPath(command: string): boolean {
  try {
    execFileSync(command, ["--version"], { stdio: "pipe" });
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}
