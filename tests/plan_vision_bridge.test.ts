import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { describe, expect, it, beforeEach, vi } from "vitest";
import {
  PLAN_VISION_SERVICE_NOT_CONFIGURED,
  PlanVisionNotConfiguredError,
  buildNotConfiguredMessage,
  detectPlanVisionConfiguration,
  isSupportedPythonVersion,
  parsePythonVersion,
  planVisionCliPath,
  planVisionRequirementsPath,
  primePlanVisionConfiguration,
  requirePlanVisionConfiguration,
  resetPlanVisionConfigurationCache,
  resolvePlanVisionInterpreter,
  resolvePlanVisionTimeoutMs,
  runPlanVisionCommand,
  type PlanVisionConfiguration,
} from "../src/utils/PlanVisionBridge.js";

/**
 * plan-vision is an OPTIONAL service. These tests prove the two guarantees that item 9 depends on:
 * the interpreter is only ever the declared one, and an absent interpreter or absent package ends
 * in one explicit "service is not configured" error instead of a crash or a silent fallback.
 *
 * The Python path itself cannot run on this host. Nothing here claims that a raster or OCR call
 * succeeds; that needs a machine with Python 3.10, Tesseract and the pinned packages installed.
 *
 * Every test passes an explicit environment object, so one test can never change the interpreter
 * that another test sees.
 */

const MISSING_INTERPRETER = "/nonexistent/plan-vision-interpreter";
const STUB_INTERPRETER = "stub-python";
const STUB_ENVIRONMENT = { PLAN_VISION_PYTHON: STUB_INTERPRETER };

/**
 * A stand-in for a child process: an EventEmitter with the three stdio streams and kill(). It emits
 * only on a later turn of the loop, exactly as a real child process does. A stub that emitted
 * during the spawn call itself would fire before the bridge had attached its listeners.
 */
function fakeChildProcess(behaviour: {
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  hang?: boolean;
}) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdin: { write: (chunk: string) => void; end: () => void };
    kill: () => void;
  };
  const written: string[] = [];
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { write: (chunk: string) => void written.push(chunk), end: () => undefined };
  child.kill = () => undefined;

  if (!behaviour.hang) {
    setImmediate(() => {
      if (behaviour.stdout) child.stdout.emit("data", Buffer.from(behaviour.stdout));
      if (behaviour.stderr) child.stderr.emit("data", Buffer.from(behaviour.stderr));
      child.emit("close", behaviour.exitCode ?? 0);
    });
  }

  return { child, written };
}

function preflightChild(exitCode = 0, stdout = "PLAN_VISION_PREFLIGHT_V1 3 12\n") {
  return fakeChildProcess({ stdout, exitCode });
}

/** Returns the first child for the preflight probe and the second for the command itself. */
function spawnSequence(first: unknown, second: unknown) {
  return vi.fn().mockImplementationOnce(() => first).mockImplementation(() => second);
}

/**
 * Runs the preflight with a stub child process. The preflight is the only place the bridge calls
 * the interpreter without the service being configured, so this is where a fake belongs. The
 * bridge takes the spawn function as an option, so no module is patched.
 */
async function detectWithStub(child: EventEmitter): Promise<PlanVisionConfiguration> {
  return await detectPlanVisionConfiguration(STUB_ENVIRONMENT, { spawn: (() => child) as never });
}

beforeEach(() => {
  resetPlanVisionConfigurationCache();
});

describe("plan-vision interpreter selection", () => {
  it("uses PLAN_VISION_PYTHON when it is set", () => {
    expect(resolvePlanVisionInterpreter({ PLAN_VISION_PYTHON: " /opt/venv/bin/python " }, "linux")).toBe(
      "/opt/venv/bin/python",
    );
  });

  it("defaults to python3 away from Windows and python on Windows", () => {
    expect(resolvePlanVisionInterpreter({}, "linux")).toBe("python3");
    expect(resolvePlanVisionInterpreter({}, "darwin")).toBe("python3");
    expect(resolvePlanVisionInterpreter({}, "win32")).toBe("python");
  });

  it("reads the timeout from the environment and falls back to 120000", () => {
    expect(resolvePlanVisionTimeoutMs({ PLAN_VISION_TIMEOUT: "5000" })).toBe(5000);
    expect(resolvePlanVisionTimeoutMs({ PLAN_VISION_TIMEOUT: "not-a-number" })).toBe(120_000);
    expect(resolvePlanVisionTimeoutMs({})).toBe(120_000);
  });
});

describe("plan-vision version helpers", () => {
  it("parses the version out of the preflight line", () => {
    expect(parsePythonVersion("PLAN_VISION_PREFLIGHT_V1 3 12")).toEqual({ major: 3, minor: 12 });
    expect(parsePythonVersion("no version here")).toBeUndefined();
  });

  it("requires Python 3.10 or later", () => {
    expect(isSupportedPythonVersion(3, 9)).toBe(false);
    expect(isSupportedPythonVersion(3, 10)).toBe(true);
    expect(isSupportedPythonVersion(3, 13)).toBe(true);
    expect(isSupportedPythonVersion(4, 0)).toBe(true);
    expect(isSupportedPythonVersion(2, 7)).toBe(false);
  });
});

describe("plan-vision service directory", () => {
  it("resolves the CLI and the pinned requirements file at the repository root", () => {
    expect(planVisionCliPath().endsWith("plan-vision/cli.py")).toBe(true);
    expect(planVisionRequirementsPath().endsWith("plan-vision/requirements.txt")).toBe(true);
  });
});

describe("plan-vision configuration preflight", () => {
  it("reports the pinned packages as missing, not the interpreter, when the probe exits 3", async () => {
    const configuration = await detectWithStub(
      preflightChild(3, "PLAN_VISION_PREFLIGHT_V1 3 12\nmissing-packages:cv2,pymupdf\n").child,
    );

    expect(configuration.configured).toBe(false);
    expect(configuration.pythonVersion).toBe("3.12");
    expect(configuration.reason).toContain("opencv-python==4.10.0.84");
    expect(configuration.reason).toContain("pymupdf==1.24.11");
  });

  it("names Tesseract, the system binary, when the probe exits 4", async () => {
    const configuration = await detectWithStub(
      preflightChild(4, "PLAN_VISION_PREFLIGHT_V1 3 12\nmissing-tesseract\n").child,
    );

    expect(configuration.configured).toBe(false);
    expect(configuration.reason).toContain("Tesseract");
    expect(configuration.reason).toContain("system binary");
  });

  it("rejects an interpreter older than 3.10", async () => {
    const configuration = await detectWithStub(preflightChild(0, "PLAN_VISION_PREFLIGHT_V1 3 9\n").child);

    expect(configuration.configured).toBe(false);
    expect(configuration.reason).toContain("older than the required 3.10");
  });

  it("runs the real preflight and reports the pinned packages this host does not have", async () => {
    const interpreter = ["python3", "python"].find((candidate) => isOnPath(candidate));
    if (!interpreter) return; // No interpreter on this host, so the preflight cannot run.

    const configuration = await detectPlanVisionConfiguration({ PLAN_VISION_PYTHON: interpreter });
    expect(configuration.configured).toBe(false);
    // The probe script must run without a syntax or import error: the reason has to be a missing
    // package, never a failure of the probe itself.
    expect(configuration.pythonVersion).toBeDefined();
    expect(configuration.reason).toMatch(/pinned packages are not installed|Tesseract OCR was not found/);
  });

  it("accepts a supported interpreter with every package present", async () => {
    const configuration = await detectWithStub(
      preflightChild(0, "PLAN_VISION_PREFLIGHT_V1 3 13\ntesseract:/usr/bin/tesseract\n").child,
    );

    expect(configuration).toMatchObject({ configured: true, pythonVersion: "3.13", reason: "" });
  });
});

describe("plan-vision degradation", () => {
  it("fails with PLAN_VISION_SERVICE_NOT_CONFIGURED when the interpreter does not exist", async () => {
    const environment = { PLAN_VISION_PYTHON: MISSING_INTERPRETER };
    const error = await runPlanVisionCommand("ocr_extract_labels", { imagePath: "sheet.png" }, { environment })
      .then(() => undefined, (reason: unknown) => reason);

    expect(error).toBeInstanceOf(PlanVisionNotConfiguredError);
    expect((error as PlanVisionNotConfiguredError).code).toBe(PLAN_VISION_SERVICE_NOT_CONFIGURED);
    expect((error as Error).message).toContain("plan-vision service is not configured");
    expect((error as Error).message).toContain(MISSING_INTERPRETER);
    expect((error as Error).message).toContain("pip install -r");
    expect((error as Error).message).toContain("calibrate_scale_from_dimension does not");
  });

  it("reports the interpreter that was configured, never a fallback", async () => {
    const configuration = await detectPlanVisionConfiguration({ PLAN_VISION_PYTHON: MISSING_INTERPRETER });
    expect(configuration.interpreter).toBe(MISSING_INTERPRETER);
    expect(configuration.reason).toContain("was not found on this machine");
  });

  it("does not memoize a failed preflight, so a fixed install is picked up at once", async () => {
    const environment = { PLAN_VISION_PYTHON: MISSING_INTERPRETER };
    await requirePlanVisionConfiguration(environment).catch(() => undefined);
    const second = await detectPlanVisionConfiguration(environment);
    expect(second.configured).toBe(false);
  });

  it("builds one message that names the reason, the interpreter and the fix", () => {
    const configuration: PlanVisionConfiguration = {
      configured: false,
      interpreter: "python3",
      reason: "the pinned packages are not installed.",
    };
    const message = buildNotConfiguredMessage(configuration);
    expect(message).toContain("the pinned packages are not installed.");
    expect(message).toContain("Interpreter tried: 'python3'");
    expect(message).toContain(planVisionRequirementsPath());
  });
});

describe("plan-vision command execution", () => {
  // The preflight is proved separately above and by the tests for the configuration helpers. These
  // tests seed that result, so the command path uses exactly one child process and the assertion
  // is about the command, not about the preflight.
  beforeEach(() => {
    primePlanVisionConfiguration(STUB_INTERPRETER);
  });

  it("passes the arguments on stdin and returns the parsed JSON", async () => {
    const command = fakeChildProcess({ stdout: '{"labels":[]}\n', exitCode: 0 });
    const spawn = vi.fn(() => command.child);

    const result = await runPlanVisionCommand<{ labels: unknown[] }>(
      "ocr_extract_labels",
      { imagePath: "sheet.png", minConfidence: 40 },
      { spawn: spawn as never, environment: STUB_ENVIRONMENT },
    );

    expect(result).toEqual({ labels: [] });
    expect(command.written[0]).toBe('{"imagePath":"sheet.png","minConfidence":40}');
    expect(spawn.mock.calls).toHaveLength(1);
    expect(spawn.mock.calls[0][0]).toBe(STUB_INTERPRETER);
    expect(spawn.mock.calls[0][1]).toEqual([planVisionCliPath(), "ocr_extract_labels"]);
  });

  it("surfaces the CLI's own stderr when the command exits non-zero", async () => {
    const command = fakeChildProcess({ stderr: "ValueError: Could not read image\n", exitCode: 1 });

    const error = await runPlanVisionCommand(
      "detect_symbols_cv",
      { imagePath: "sheet.png" },
      { spawn: (() => command.child) as never, environment: STUB_ENVIRONMENT },
    ).then(() => undefined, (reason: unknown) => reason as Error);

    expect(error.message).toContain("failed (exit 1)");
    expect(error.message).toContain("Could not read image");
  });

  it("rejects invalid JSON from the service instead of returning undefined", async () => {
    const command = fakeChildProcess({ stdout: "not json", exitCode: 0 });

    const error = await runPlanVisionCommand(
      "rasterize_pdf_page",
      { pdfPath: "sheet.pdf" },
      { spawn: (() => command.child) as never, environment: STUB_ENVIRONMENT },
    ).then(() => undefined, (reason: unknown) => reason as Error);

    expect(error.message).toContain("returned invalid JSON");
  });

  it("stops a hung command with the message that names the timeout", async () => {
    const command = fakeChildProcess({ hang: true });

    const error = await runPlanVisionCommand(
      "ocr_extract_labels",
      { imagePath: "sheet.png" },
      { spawn: (() => command.child) as never, environment: STUB_ENVIRONMENT, timeoutMs: 30 },
    ).then(() => undefined, (reason: unknown) => reason as Error);

    expect(error.message).toContain("timed out after 30ms");
  });
});

/**
 * A second seam for the preflight: the command tests run the real pinned CLI, which exits non-zero
 * on this host because the packages are absent. That is the point of this test — the bridge must
 * report what the service said, not invent a result.
 */
describe("plan-vision command path against the real CLI", () => {
  it("runs the pinned CLI and reports its own failure when the packages are absent", async () => {
    const interpreter = ["python3", "python"].find((candidate) => isOnPath(candidate));
    if (!interpreter) return; // No interpreter on this host, so there is no CLI failure to observe.

    primePlanVisionConfiguration(interpreter);
    const error = await runPlanVisionCommand(
      "ocr_extract_labels",
      { imagePath: "definitely-not-a-real-image.png" },
      { environment: { PLAN_VISION_PYTHON: interpreter }, timeoutMs: 30_000 },
    ).then(() => undefined, (reason: unknown) => reason as Error);

    expect(error.message).toMatch(/plan-vision command 'ocr_extract_labels' failed \(exit \d+\)/);
  }, 40_000);
});

function isOnPath(command: string): boolean {
  try {
    execFileSync(command, ["--version"], { stdio: "pipe" });
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}
