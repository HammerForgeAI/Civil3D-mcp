import { spawn, type SpawnOptionsWithoutStdio } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger } from "./logger.js";
import { MINIMUM_PYTHON_VERSION, PIP_PACKAGES, describeMissingPackages } from "./planVisionRequirements.js";

const log = createLogger("PlanVisionBridge");

/**
 * plan-vision is an OPTIONAL service. Nothing here runs unless a tool action asks for it, and no
 * part of server startup touches it. The bridge proves that once, cheaply, and then either runs the
 * command or fails with one explicit message that names the interpreter and the fix.
 */

const DEFAULT_TIMEOUT_MS = 120_000;
const PREFLIGHT_TIMEOUT_MS = 20_000;
const PROBE_MARKER = "PLAN_VISION_PREFLIGHT_V1";

export const PLAN_VISION_SERVICE_NOT_CONFIGURED = "PLAN_VISION_SERVICE_NOT_CONFIGURED";

export interface PlanVisionConfiguration {
  configured: boolean;
  /** The interpreter the bridge tried. Shown in the error, so a wrong PLAN_VISION_PYTHON is obvious. */
  interpreter: string;
  /** Why the service is unusable. Empty when `configured` is true. */
  reason: string;
  /** Python "major.minor", when the interpreter answered. */
  pythonVersion?: string;
}

export class PlanVisionNotConfiguredError extends Error {
  public readonly code = PLAN_VISION_SERVICE_NOT_CONFIGURED;

  constructor(public readonly configuration: PlanVisionConfiguration) {
    super(buildNotConfiguredMessage(configuration));
    this.name = "PlanVisionNotConfiguredError";
  }
}

export function buildNotConfiguredMessage(configuration: PlanVisionConfiguration): string {
  return (
    `plan-vision service is not configured: ${configuration.reason} ` +
    `Interpreter tried: '${configuration.interpreter}'. Install Python ${MINIMUM_PYTHON_VERSION} or later ` +
    `and the pinned packages with 'pip install -r "${planVisionRequirementsPath()}"', or set ` +
    "PLAN_VISION_PYTHON to the interpreter's full path. " +
    "The 5 raster and OCR actions need this service; calibrate_scale_from_dimension does not."
  );
}

/**
 * The packager copies src/standards/data into build/, but plan-vision/ stays at the repository
 * root, because it is a service and not a compiled asset. From src/utils and from build/utils the
 * repository root is two levels up, so one path shape covers the tests and the built server.
 */
export function planVisionServiceDirectory(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "plan-vision");
}

export function planVisionCliPath(): string {
  return path.join(planVisionServiceDirectory(), "cli.py");
}

export function planVisionRequirementsPath(): string {
  return path.join(planVisionServiceDirectory(), "requirements.txt");
}

export function resolvePlanVisionInterpreter(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const configured = environment.PLAN_VISION_PYTHON?.trim();
  if (configured) return configured;
  return platform === "win32" ? "python" : "python3";
}

export function resolvePlanVisionTimeoutMs(
  environment: NodeJS.ProcessEnv = process.env,
): number {
  const parsed = Number.parseInt(environment.PLAN_VISION_TIMEOUT ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
}

/**
 * The preflight prints "PLAN_VISION_PREFLIGHT_V1 <major> <minor>". The separator is accepted as a
 * space or a dot so a probe that reports "3.12" is read the same way.
 */
export function parsePythonVersion(stdout: string): { major: number; minor: number } | undefined {
  const marker = new RegExp(`${PROBE_MARKER}\\s+(\\d+)[.\\s]+(\\d+)`).exec(stdout);
  const match = marker ?? /^(\d+)[.\s]+(\d+)/.exec(stdout.trim());
  if (!match) return undefined;
  return { major: Number.parseInt(match[1], 10), minor: Number.parseInt(match[2], 10) };
}

export function isSupportedPythonVersion(major: number, minor: number): boolean {
  const [requiredMajor, requiredMinor] = MINIMUM_PYTHON_VERSION.split(".").map((part) =>
    Number.parseInt(part, 10),
  );
  if (major !== requiredMajor) return major > requiredMajor;
  return minor >= requiredMinor;
}

/**
 * One script, one child process, two answers: the interpreter version on stdout, and an exit code
 * that says whether every pinned package imports. When `checkTesseract` is set the script also
 * reports whether the Tesseract system binary is reachable, because that binary is not a pip
 * package and its absence is the failure a reader cannot fix from Node.
 *
 * Exit codes: 0 ready, 3 a pinned package is missing, 4 Tesseract is missing.
 */
function preflightScript(checkTesseract: boolean): string {
  const packages = PIP_PACKAGES.map((entry) => entry.importName).join(",");
  const lines = [
    "import sys",
    "from importlib import util as importlib_util",
    `print("${PROBE_MARKER}", sys.version_info[0], sys.version_info[1])`,
    `missing = [name for name in "${packages}".split(",") if importlib_util.find_spec(name) is None]`,
    "if missing:",
    "    print('missing-packages:' + ','.join(missing))",
    "    sys.exit(3)",
  ];

  if (checkTesseract) {
    lines.push(
      "import os, shutil",
      "tesseract = os.environ.get('TESSERACT_CMD') or shutil.which('tesseract')",
      "if not tesseract or not os.path.exists(tesseract):",
      "    print('missing-tesseract')",
      "    sys.exit(4)",
      "print('tesseract:' + tesseract)",
    );
  }

  lines.push("sys.exit(0)");
  return lines.join("\n");
}

interface ProbeResult {
  exitCode: number | null;
  spawnErrorCode?: string;
  stdout: string;
  stderr: string;
}

function probe(
  interpreter: string,
  checkTesseract: boolean,
  spawnImplementation: typeof spawn,
): Promise<ProbeResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawnImplementation(interpreter, ["-c", preflightScript(checkTesseract)], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      resolve({ exitCode: null, stdout, stderr: `${stderr}\npreflight timed out` });
    }, PREFLIGHT_TIMEOUT_MS);

    child.stdout?.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr?.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: null, spawnErrorCode: (error as NodeJS.ErrnoException).code, stdout, stderr });
    });
    child.on("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode, stdout, stderr });
    });
  });
}

export interface PlanVisionDetectionOptions {
  checkTesseract?: boolean;
  /** Injected in tests, so the preflight can be exercised without a Python install. */
  spawn?: typeof spawn;
}

export async function detectPlanVisionConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
  options: PlanVisionDetectionOptions = {},
): Promise<PlanVisionConfiguration> {
  const interpreter = resolvePlanVisionInterpreter(environment);
  const checkTesseract = options.checkTesseract ?? false;
  const result = await probe(interpreter, checkTesseract, options.spawn ?? spawn);
  const version = parsePythonVersion(result.stdout);
  const base = { interpreter, pythonVersion: version ? `${version.major}.${version.minor}` : undefined };

  if (result.spawnErrorCode === "ENOENT") {
    return {
      configured: false,
      ...base,
      reason: `the interpreter '${interpreter}' was not found on this machine.`,
    };
  }

  if (result.spawnErrorCode) {
    return {
      configured: false,
      ...base,
      reason: `the interpreter '${interpreter}' could not be started (${result.spawnErrorCode}).`,
    };
  }

  if (result.exitCode === 3) {
    const missing = result.stdout.split("missing-packages:")[1]?.trim() ?? "";
    const described = missing.length > 0
      ? describeMissingPackages(missing.split(",").map((name) => name.trim()))
      : "the pinned packages are missing.";
    return { configured: false, ...base, reason: `the pinned packages are not installed (${described}).` };
  }

  if (result.exitCode === 4) {
    return {
      configured: false,
      ...base,
      reason:
        "Tesseract OCR was not found. It is a system binary, not a pip package.",
    };
  }

  if (result.exitCode !== 0) {
    return {
      configured: false,
      ...base,
      reason: `the interpreter '${interpreter}' failed the preflight check (exit ${result.exitCode}${
        result.stderr.trim() ? `: ${result.stderr.trim().split("\n")[0]}` : ""
      }).`,
    };
  }

  if (!version) {
    return {
      configured: false,
      ...base,
      reason: `the interpreter '${interpreter}' did not report a Python version.`,
    };
  }

  if (!isSupportedPythonVersion(version.major, version.minor)) {
    return {
      configured: false,
      ...base,
      reason: `Python ${version.major}.${version.minor} is older than the required ${MINIMUM_PYTHON_VERSION}.`,
    };
  }

  return { configured: true, ...base, reason: "" };
}

const configurationCache = new Map<string, Promise<PlanVisionConfiguration>>();

/** Clears the memoized preflight. Tests and configuration changes need this. */
export function resetPlanVisionConfigurationCache(): void {
  configurationCache.clear();
}

/**
 * Seeds the memoized preflight with a known-good result for one interpreter. A caller that has
 * already proved the service works — a setup check, or a test with a fake child process — should
 * not pay for a second probe, and the command path then needs only one child process.
 */
export function primePlanVisionConfiguration(interpreter: string): void {
  configurationCache.set(
    `${interpreter}\u0000packages`,
    Promise.resolve({ configured: true, interpreter, reason: "" }),
  );
}

export async function requirePlanVisionConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
  options: PlanVisionDetectionOptions = {},
): Promise<PlanVisionConfiguration> {
  const interpreter = resolvePlanVisionInterpreter(environment);
  const key = `${interpreter}\u0000${options.checkTesseract ? "tesseract" : "packages"}`;
  const cached = configurationCache.get(key);
  if (cached) {
    const configuration = await cached;
    if (configuration.configured) return configuration;
    configurationCache.delete(key);
    throw new PlanVisionNotConfiguredError(configuration);
  }

  const pending = detectPlanVisionConfiguration(environment, options);
  configurationCache.set(key, pending);
  const configuration = await pending;
  if (!configuration.configured) {
    configurationCache.delete(key);
    throw new PlanVisionNotConfiguredError(configuration);
  }
  return configuration;
}

export interface PlanVisionRunOptions {
  /** Injected in tests, so the bridge can be exercised without a Python install. */
  spawn?: typeof spawn;
  timeoutMs?: number;
  environment?: NodeJS.ProcessEnv;
  /** OCR actions pass true, so a missing Tesseract binary is reported as a configuration error. */
  requireTesseract?: boolean;
}

/**
 * Runs one plan-vision CLI command as a child process and returns its parsed JSON. The arguments
 * go in on stdin, exactly as the CLI documents, which keeps them off the command line.
 */
export async function runPlanVisionCommand<T = unknown>(
  command: string,
  args: Record<string, unknown>,
  options: PlanVisionRunOptions = {},
): Promise<T> {
  const environment = options.environment ?? process.env;
  await requirePlanVisionConfiguration(environment, {
    checkTesseract: options.requireTesseract ?? false,
    spawn: options.spawn,
  });

  const timeoutMs = options.timeoutMs ?? resolvePlanVisionTimeoutMs(environment);
  const interpreter = resolvePlanVisionInterpreter(environment);
  const cliPath = planVisionCliPath();
  const spawnImplementation = options.spawn ?? spawn;

  return new Promise<T>((resolve, reject) => {
    const child = spawnImplementation(interpreter, [cliPath, command], {
      cwd: planVisionServiceDirectory(),
      stdio: ["pipe", "pipe", "pipe"],
    } as SpawnOptionsWithoutStdio);

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`plan-vision command '${command}' timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    child.stdout?.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr?.on("data", (chunk) => (stderr += chunk.toString()));

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`plan-vision command '${command}' could not start: ${error.message}`));
    });

    child.on("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      if (exitCode !== 0) {
        log.error("plan-vision command failed", { command, exitCode, stderr: stderr.trim() });
        reject(
          new Error(
            `plan-vision command '${command}' failed (exit ${exitCode}): ${
              stderr.trim() || "no error output"
            }`,
          ),
        );
        return;
      }

      try {
        resolve(JSON.parse(stdout.trim()) as T);
      } catch {
        reject(new Error(`plan-vision command '${command}' returned invalid JSON: ${stdout.trim()}`));
      }
    });

    child.stdin?.write(JSON.stringify(args));
    child.stdin?.end();
  });
}
