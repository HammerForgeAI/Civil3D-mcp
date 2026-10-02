import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import * as net from "node:net";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger } from "./logger.js";

const log = createLogger("EnvironmentPreflight");

/**
 * Reduced environment preflight (port plan item 23).
 *
 * The donor `setup_check.py` verifies a pywin32 stack: pythoncom, win32com,
 * pythonnet, pydantic and a Civil 3D installation discovered by folder name.
 * (antonhofstader/Civil3D-mcp-python-COM, MIT, Copyright (c) 2026 Fabian Anton
 * Munoz.) This fork has none of those runtimes, so this module keeps only the
 * checks it can genuinely observe from the Node MCP server:
 *
 *   1. the Node runtime against `engines.node` in package.json,
 *   2. the plugin load state and the configured plugin port state,
 *   3. the configured plugin file roots, and whether each one exists and is
 *      writable by this process,
 *   4. the presence of the fork's optional dependencies.
 *
 * Every check reports `ok`, `warn` or `fail` plus the exact value the probe saw.
 *
 * Visibility note: `civil3d_health` keeps its existing failure contract, so a
 * plugin that cannot answer still fails the tool with the same connection error
 * it always produced. The plugin-load check therefore appears in the report of
 * a plugin that answered; its `fail` branch, and the `free` and `unknown` port
 * states, are live code paths covered by tests/preflight.test.ts.
 */

export type PreflightStatus = "ok" | "warn" | "fail";

export interface PreflightCheck {
  /** Stable identifier, e.g. "node-version" or "file-root:CIVIL3D_IMPORT_ROOTS:C:\\proj". */
  id: string;
  /** Reader-facing name of what was checked. */
  label: string;
  status: PreflightStatus;
  /** The exact value the probe observed. */
  value: string;
  /** One line of guidance, present when the status is not `ok`. */
  detail?: string;
}

export interface PreflightReport {
  /** The worst status of every check: `fail` beats `warn` beats `ok`. */
  status: PreflightStatus;
  summary: { ok: number; warn: number; fail: number };
  checks: PreflightCheck[];
}

export type FileRootState =
  | "directory-writable"
  | "directory-read-only"
  | "missing"
  | "not-a-directory"
  | "unknown";

export type PortState = "occupied" | "free" | "unknown";

export type PluginLoadState = "loaded" | "unreachable";

export interface FileRootObservation {
  /** The environment variable the root came from, e.g. "CIVIL3D_IMPORT_ROOTS". */
  source: string;
  path: string;
  state: FileRootState;
  /** Present when the state is `unknown`. */
  error?: string;
}

export interface PluginObservation {
  /** "host:port" the plugin RPC server was probed on. */
  endpoint: string;
  port: PortState;
  load: PluginLoadState;
  pluginVersion?: string | null;
  /** Present when the plugin did not answer. */
  error?: string;
}

export interface OptionalDependencyObservation {
  id: string;
  label: string;
  purpose: string;
  present: boolean;
  /** Where it was found, when it was found. */
  location?: string | null;
}

export interface PreflightProbes {
  /** `process.versions.node`, e.g. "22.14.0". */
  nodeVersion: string;
  /** `engines.node` from package.json; `null` when the manifest has none. */
  requiredNodeRange: string | null;
  plugin: PluginObservation;
  /** Roots observed from this process environment; empty when none are configured. */
  fileRoots: FileRootObservation[];
  optionalDependencies: OptionalDependencyObservation[];
}

const FILE_ROOT_VARIABLES = [
  "CIVIL3D_FILE_ROOTS",
  "CIVIL3D_IMPORT_ROOTS",
  "CIVIL3D_EXPORT_ROOTS",
] as const;

const packageJsonPath = fileURLToPath(new URL("../../package.json", import.meta.url));
const require = createRequire(import.meta.url);

/**
 * Builds the report from already-observed probes. Pure, so the tests can pin
 * every branch without touching the real filesystem, the environment or Node.
 */
export function buildEnvironmentPreflight(probes: PreflightProbes): PreflightReport {
  const checks: PreflightCheck[] = [
    nodeVersionCheck(probes.nodeVersion, probes.requiredNodeRange),
    pluginPortCheck(probes.plugin),
    pluginLoadCheck(probes.plugin),
    ...fileRootChecks(probes.fileRoots),
    ...optionalDependencyChecks(probes.optionalDependencies),
  ];
  const summary = {
    ok: checks.filter((check) => check.status === "ok").length,
    warn: checks.filter((check) => check.status === "warn").length,
    fail: checks.filter((check) => check.status === "fail").length,
  };
  return {
    status: summary.fail > 0 ? "fail" : summary.warn > 0 ? "warn" : "ok",
    summary,
    checks,
  };
}

/**
 * Probes the environment the MCP server runs in and builds the report. The file
 * roots are read from this process environment as a proxy: the plugin's
 * FileBoundary reads the same variables from the Civil 3D process, so a root
 * must also be set in the environment that launches Civil 3D.
 */
export function collectEnvironmentPreflight(plugin: PluginObservation): PreflightReport {
  const metadata = readPackageMetadata();
  return buildEnvironmentPreflight({
    nodeVersion: process.versions.node,
    requiredNodeRange: metadata.enginesNode,
    plugin,
    fileRoots: observeFileRoots(),
    optionalDependencies: observeOptionalDependencies(metadata.optionalDependencies),
  });
}

/** Minimal view of the connection the plugin commands travel over. */
export interface PluginCommandClient {
  sendCommand(command: string, params?: unknown): Promise<unknown>;
}

export interface PluginRuntimeProbe {
  load: PluginLoadState;
  /** The health payload, present only when the plugin answered. */
  payload: Record<string, unknown> | null;
  pluginVersion: string | null;
  /** The original error, present only when the plugin did not answer. */
  error: unknown;
}

const PLUGIN_PROBE_TIMEOUT_MS = parseInt(process.env.CIVIL3D_PREFLIGHT_PORT_TIMEOUT ?? "500", 10);

/**
 * Reports whether something accepts a TCP connection on the plugin endpoint.
 * This is the literal "is the port occupied" fact, independent of the plugin
 * protocol, so it stays truthful when another process holds the port.
 */
export function probePort(host: string, port: number, timeoutMs = PLUGIN_PROBE_TIMEOUT_MS): Promise<PortState> {
  return new Promise<PortState>((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const finish = (state: PortState) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      socket.destroy();
      resolve(state);
    };

    timer = setTimeout(() => finish("unknown"), timeoutMs);
    timer.unref();

    socket.once("connect", () => finish("occupied"));
    socket.once("timeout", () => finish("unknown"));
    socket.once("error", (error: NodeJS.ErrnoException) => {
      finish(error.code === "ECONNREFUSED" ? "free" : "unknown");
    });
    socket.setTimeout(timeoutMs);
    socket.connect(port, host);
  });
}

/**
 * Runs the health command and reports the plugin load state. A plugin that
 * cannot answer is returned as `unreachable` with the original error, which the
 * caller rethrows so `civil3d_health` keeps its existing failure contract.
 */
export async function probePluginRuntime(client: PluginCommandClient): Promise<PluginRuntimeProbe> {
  try {
    const payload = await client.sendCommand("getCivil3DHealth", {});
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      return {
        load: "unreachable",
        payload: null,
        pluginVersion: null,
        error: new Error("The Civil 3D plugin returned a health payload that is not a JSON object."),
      };
    }
    const record = payload as Record<string, unknown>;
    return {
      load: "loaded",
      payload: record,
      pluginVersion: typeof record.pluginVersion === "string" ? record.pluginVersion : null,
      error: null,
    };
  } catch (error) {
    log.warn("The Civil 3D plugin did not answer the health command", {
      error: error instanceof Error ? error.message : String(error),
    });
    return { load: "unreachable", payload: null, pluginVersion: null, error };
  }
}

function nodeVersionCheck(nodeVersion: string, requiredNodeRange: string | null): PreflightCheck {
  const label = "Node runtime";
  if (requiredNodeRange === null) {
    return {
      id: "node-version",
      label,
      status: "warn",
      value: `v${nodeVersion} (package.json declares no engines.node requirement)`,
      detail: "Set engines.node in package.json so the preflight can compare the runtime.",
    };
  }

  const satisfied = satisfiesNodeRange(nodeVersion, requiredNodeRange);
  if (satisfied === null) {
    return {
      id: "node-version",
      label,
      status: "warn",
      value: `v${nodeVersion} (required ${requiredNodeRange})`,
      detail: `The requirement '${requiredNodeRange}' could not be compared against v${nodeVersion}.`,
    };
  }
  if (satisfied) {
    return {
      id: "node-version",
      label,
      status: "ok",
      value: `v${nodeVersion} (required ${requiredNodeRange})`,
    };
  }
  return {
    id: "node-version",
    label,
    status: "fail",
    value: `v${nodeVersion} (required ${requiredNodeRange})`,
    detail: `Install Node ${requiredNodeRange} and restart the MCP server.`,
  };
}

function pluginPortCheck(plugin: PluginObservation): PreflightCheck {
  const label = `Plugin port ${plugin.endpoint}`;
  const status: PreflightStatus = plugin.port === "occupied" ? "ok" : plugin.port === "free" ? "fail" : "warn";
  const value =
    plugin.port === "occupied"
      ? `${plugin.endpoint} is occupied`
      : plugin.port === "free"
        ? `${plugin.endpoint} is free`
        : `${plugin.endpoint} could not be probed`;
  if (status === "ok") {
    return { id: "plugin-port", label, status, value };
  }
  return {
    id: "plugin-port",
    label,
    status,
    value,
    detail:
      status === "fail"
        ? "Nothing is listening. Load Civil3DMcpPlugin.dll in Civil 3D, or set CIVIL3D_PORT to the port the plugin uses."
        : `The probe did not settle: ${plugin.error ?? "no response"}.`,
  };
}

function pluginLoadCheck(plugin: PluginObservation): PreflightCheck {
  const label = "Civil 3D plugin load state";
  if (plugin.load === "loaded") {
    return {
      id: "plugin-load",
      label,
      status: "ok",
      value: `loaded (plugin version ${plugin.pluginVersion ?? "unknown"})`,
    };
  }
  return {
    id: "plugin-load",
    label,
    status: "fail",
    value: `not reachable (${plugin.error ?? "no response"})`,
    detail: "Install the bundle with scripts/install-bundle.ps1, then restart Civil 3D.",
  };
}

function fileRootChecks(roots: FileRootObservation[]): PreflightCheck[] {
  if (roots.length === 0) {
    return [
      {
        id: "file-roots",
        label: "Plugin file roots",
        status: "ok",
        value: "unset (the plugin falls back to the current user's Documents folder)",
        detail:
          "Set CIVIL3D_FILE_ROOTS, or CIVIL3D_IMPORT_ROOTS and CIVIL3D_EXPORT_ROOTS, in the environment that launches Civil 3D to bound file tools to project folders.",
      },
    ];
  }
  return roots.map(fileRootCheck);
}

function fileRootCheck(root: FileRootObservation): PreflightCheck {
  const id = `file-root:${root.source}:${root.path}`;
  const label = `File root ${root.source}`;
  const value = `${root.path} (${root.state})`;
  if (root.state === "directory-writable") {
    return { id, label, status: "ok", value };
  }
  if (root.state === "unknown") {
    return {
      id,
      label,
      status: "warn",
      value,
      detail: `The root could not be inspected: ${root.error ?? "unknown error"}.`,
    };
  }
  const detail =
    root.state === "missing"
      ? "The plugin refuses every path outside an existing root. Create the folder or fix the variable."
      : root.state === "directory-read-only"
        ? "Export tools write under this root. Give the current user write access."
        : "The configured root is not a directory.";
  return { id, label, status: "fail", value, detail };
}

function optionalDependencyChecks(dependencies: OptionalDependencyObservation[]): PreflightCheck[] {
  return dependencies.map((dependency) => {
    const id = `optional-dependency:${dependency.id}`;
    const label = `Optional dependency ${dependency.label}`;
    const value = dependency.present
      ? `${dependency.location ?? "present"} (${dependency.purpose})`
      : `not installed (${dependency.purpose})`;
    if (dependency.present) {
      return { id, label, status: "ok", value };
    }
    return {
      id,
      label,
      status: "warn",
      value,
      detail: "Optional: the MCP server runs without it. Install it only for this capability.",
    };
  });
}

/**
 * Compares a Node version against the `engines.node` syntax this fork uses
 * (`>=18.17.0`). Returns `null` when either side cannot be compared, so the
 * caller can report `warn` instead of inventing a verdict. This is not a
 * general semver implementation and does not accept `||` ranges.
 */
export function satisfiesNodeRange(version: string, range: string): boolean | null {
  const versionParts = parseVersion(version);
  if (versionParts === null) {
    return null;
  }
  const clauses = range.trim().split(/\s+/).filter((clause) => clause.length > 0);
  if (clauses.length === 0) {
    return null;
  }
  for (const clause of clauses) {
    const comparison = compareClause(versionParts, clause);
    if (comparison === null) {
      return null;
    }
    if (!comparison) {
      return false;
    }
  }
  return true;
}

function compareClause(version: number[], clause: string): boolean | null {
  const match = /^(>=|<=|>|<|=)?\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(clause);
  if (match === null) {
    return null;
  }
  const operator = match[1] ?? "=";
  const target = [Number(match[2]), Number(match[3] ?? 0), Number(match[4] ?? 0)];
  for (let index = 0; index < 3; index += 1) {
    if (version[index] !== target[index]) {
      return operator.startsWith(">")
        ? version[index] > target[index]
        : operator.startsWith("<")
          ? version[index] < target[index]
          : false;
    }
  }
  return operator === "=" || operator === ">=" || operator === "<=";
}

function parseVersion(value: string): number[] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(value.trim());
  if (match === null) {
    return null;
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Reads the required Node range and any declared optional dependencies. */
export function readPackageMetadata(): { enginesNode: string | null; optionalDependencies: string[] } {
  try {
    const raw = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      engines?: { node?: string };
      optionalDependencies?: Record<string, string>;
    };
    const enginesNode = typeof raw.engines?.node === "string" ? raw.engines.node : null;
    return { enginesNode, optionalDependencies: Object.keys(raw.optionalDependencies ?? {}) };
  } catch (error) {
    log.warn("Could not read package.json for the environment preflight", {
      path: packageJsonPath,
      error: String(error),
    });
    return { enginesNode: null, optionalDependencies: [] };
  }
}

/** Splits one configured root variable the way the plugin's FileBoundary does. */
export function parseRootList(configured: string | undefined): string[] {
  if (configured === undefined || configured.trim().length === 0) {
    return [];
  }
  return configured
    .split(delimiter)
    .map((root) => root.trim())
    .filter((root) => root.length > 0);
}

/** Observes one configured root: does it exist, is it a directory, is it writable? */
export function observeFileRoot(source: string, path: string): FileRootObservation {
  try {
    if (!statSync(path).isDirectory()) {
      return { source, path, state: "not-a-directory" };
    }
    accessSync(path, constants.W_OK);
    return { source, path, state: "directory-writable" };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { source, path, state: "missing" };
    }
    if (code === "ENOTDIR") {
      return { source, path, state: "not-a-directory" };
    }
    if (code === "EACCES" || code === "EPERM") {
      return { source, path, state: "directory-read-only" };
    }
    return { source, path, state: "unknown", error: error instanceof Error ? error.message : String(error) };
  }
}

function observeFileRoots(): FileRootObservation[] {
  const observations: FileRootObservation[] = [];
  for (const variable of FILE_ROOT_VARIABLES) {
    for (const path of parseRootList(process.env[variable])) {
      observations.push(observeFileRoot(variable, path));
    }
  }
  return observations;
}

interface OptionalDependencySpec {
  id: string;
  label: string;
  purpose: string;
  /** Returns where the dependency was found, or `null` when it is absent. */
  detect: () => string | null;
}

/**
 * The fork's optional dependencies: the capabilities it ships that are not
 * needed to run the MCP server. The donor's pip packages
 * (fastmcp, pywin32, pythonnet, pydantic) have no counterpart here, and the
 * csproj has no PackageReference, so no NuGet or Python entry belongs.
 */
const OPTIONAL_DEPENDENCIES: OptionalDependencySpec[] = [
  {
    id: "docker",
    label: "Docker CLI",
    purpose: "container deployment only (docs/DEPLOYMENT.md)",
    detect: () => findExecutable("docker"),
  },
  {
    id: "mcpb",
    label: "@anthropic-ai/mcpb",
    purpose: "Claude Desktop .mcpb packaging (npm run package:claude)",
    detect: () => resolvePackage("@anthropic-ai/mcpb"),
  },
];

function observeOptionalDependencies(
  declaredOptionalDependencies: string[],
): OptionalDependencyObservation[] {
  const declared = new Set(declaredOptionalDependencies);
  const specs: OptionalDependencySpec[] = [
    ...OPTIONAL_DEPENDENCIES,
    ...[...declared]
      .filter((name) => !OPTIONAL_DEPENDENCIES.some((spec) => spec.label === name))
      .map((name) => ({
        id: name.replace(/[/@]/g, "-"),
        label: name,
        purpose: "declared in package.json optionalDependencies",
        detect: () => resolvePackage(name),
      })),
  ];

  return specs.map((spec) => {
    const location = spec.detect();
    return {
      id: spec.id,
      label: spec.label,
      purpose: spec.purpose,
      present: location !== null,
      location,
    };
  });
}

/** Finds an executable on PATH without starting it. */
export function findExecutable(name: string): string | null {
  const pathValue = process.env.PATH ?? "";
  if (pathValue.trim().length === 0) {
    return null;
  }
  const extensions = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
  for (const directory of pathValue.split(delimiter)) {
    if (directory.trim().length === 0) {
      continue;
    }
    for (const extension of extensions) {
      const candidate = join(directory, `${name}${extension}`);
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Keep looking: a missing entry is the normal case for most PATH folders.
      }
    }
  }
  return null;
}

/** Resolves an installed package without running it. */
export function resolvePackage(name: string): string | null {
  try {
    return require.resolve(name);
  } catch (error) {
    // An ESM-only package has no CommonJS entry, but it is installed.
    if ((error as NodeJS.ErrnoException).code === "ERR_PACKAGE_PATH_NOT_EXPORTED") {
      return name;
    }
    return null;
  }
}
