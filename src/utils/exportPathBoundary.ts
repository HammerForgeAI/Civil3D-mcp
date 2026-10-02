import { existsSync, linkSync, lstatSync, openSync, closeSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { Civil3DRpcError } from "./SocketClient.js";

/**
 * TypeScript half of the plugin's export boundary (`Civil3D-MCP-Plugin/FileBoundary.cs`).
 *
 * Most exports are written by the plugin itself, so `FileBoundary` is the only writer. A few
 * artifacts are built in this process instead (the BOQ workbook needs a spreadsheet library, and
 * `FileBoundary` exposes no byte-write path). Those writers must not bypass the boundary, so they
 * reuse the same rules here, in one place:
 *
 * - the path must be non-empty, fully qualified and inside an export root;
 * - the extension must be on the caller's allow-list;
 * - an existing file is refused unless `overwrite` is set;
 * - filesystem links are refused so a link cannot redirect the write outside the roots; and
 * - the bytes land through a temporary file plus an atomic create-or-replace.
 *
 * This replica is weaker than the plugin in two ways and must not be described as equal to it:
 * `FileBoundary` also locks the directory chain for the whole write and re-checks the written
 * entry for a single hard link. Node has no equivalent of those two checks, so a hostile process
 * with write access to the export folder still has a narrower race here than it has against the
 * plugin writer.
 */

const SHARED_ROOTS_VARIABLE = "CIVIL3D_FILE_ROOTS";
const EXPORT_ROOTS_VARIABLE = "CIVIL3D_EXPORT_ROOTS";

export interface ExportPathOptions {
  /** Extensions this writer may create, with or without the leading dot. */
  allowedExtensions: readonly string[];
  /** Replace an existing file. Defaults to false. */
  overwrite?: boolean;
  /** Environment to read the export roots from. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Canonicalizes a caller-supplied export path and applies the same roots, extension and overwrite
 * rules the plugin's `FileBoundary.ResolveExportPath` applies, with the same error codes.
 */
export function resolveExportPath(rawPath: string, options: ExportPathOptions): string {
  if (typeof rawPath !== "string" || rawPath.trim() === "") {
    throw invalidInput("A non-empty export path is required.");
  }

  if (!path.isAbsolute(rawPath)) {
    throw invalidInput(`The export path must be absolute: ${rawPath}`);
  }

  const canonicalPath = path.resolve(rawPath);
  const roots = loadExportRoots(options.env ?? process.env);
  const matchedRoot = roots.find((root) => isWithinRoot(canonicalPath, root));
  if (matchedRoot === undefined) {
    throw new Civil3DRpcError(
      `The export path is outside the configured roots: ${canonicalPath}`,
      "CIVIL3D.PATH_NOT_ALLOWED",
      -32040,
    );
  }

  rejectPathLinks(canonicalPath, matchedRoot);

  const allowedExtensions = new Set(options.allowedExtensions.map(normalizeExtension));
  const extension = path.extname(canonicalPath);
  if (allowedExtensions.size > 0 && !allowedExtensions.has(extension.toLowerCase())) {
    throw new Civil3DRpcError(
      `Extension '${extension}' is not allowed for this operation. Allowed extensions: ${[...allowedExtensions].sort().join(", ")}.`,
      "CIVIL3D.FILE_TYPE_NOT_ALLOWED",
      -32041,
    );
  }

  if (existsSync(canonicalPath) && options.overwrite !== true) {
    throw new Civil3DRpcError(
      `Output file already exists: ${canonicalPath}. Set overwrite=true to replace it explicitly.`,
      "CIVIL3D.CONFLICT",
      -32009,
    );
  }

  return canonicalPath;
}

/**
 * Writes bytes to a path that `resolveExportPath` already approved. The bytes go to a hidden
 * temporary file beside the target and are then moved into place, so a reader never sees a partial
 * workbook. Without `overwrite` the final name is created with an exclusive hard link, which fails
 * if anything created it in the meantime; with `overwrite` the temporary file atomically replaces
 * it.
 */
export function writeExportFileAtomic(
  resolvedPath: string,
  data: Uint8Array,
  overwrite: boolean,
): string {
  const directory = path.dirname(resolvedPath);
  const temporaryPath = path.join(directory, `.${path.basename(resolvedPath)}.${randomUUID()}.tmp`);

  try {
    writeFileSync(temporaryPath, data);
    if (overwrite) {
      renameSync(temporaryPath, resolvedPath);
    } else {
      createExclusive(temporaryPath, resolvedPath);
      unlinkSync(temporaryPath);
    }
    return resolvedPath;
  } catch (error) {
    if (isErrorCode(error, "EEXIST")) {
      throw new Civil3DRpcError(
        `Output file already exists: ${resolvedPath}. Set overwrite=true to replace it explicitly.`,
        "CIVIL3D.CONFLICT",
        -32009,
      );
    }
    throw new Civil3DRpcError(
      `Unable to write output file '${resolvedPath}': ${errorMessage(error)}`,
      "CIVIL3D.FILE_IO_ERROR",
      -32000,
    );
  } finally {
    try {
      if (existsSync(temporaryPath)) {
        unlinkSync(temporaryPath);
      }
    } catch {
      // Keep the original result. The leftover name is hidden and collision-resistant.
    }
  }
}

/**
 * Creates the final name only when it is absent. A hard link is atomic and exclusive; when the
 * volume refuses links, an exclusive open still fails on an existing name, so the no-overwrite
 * promise holds either way.
 */
function createExclusive(temporaryPath: string, finalPath: string): void {
  try {
    linkSync(temporaryPath, finalPath);
    return;
  } catch (error) {
    if (isErrorCode(error, "EEXIST")) throw error;
    if (!isErrorCode(error, "EXDEV") && !isErrorCode(error, "EPERM") && !isErrorCode(error, "ENOSYS") && !isErrorCode(error, "EACCES")) {
      throw error;
    }
  }

  const handle = openSync(finalPath, "wx");
  try {
    writeFileSync(handle, readFileSync(temporaryPath));
  } finally {
    closeSync(handle);
  }
}

function loadExportRoots(env: NodeJS.ProcessEnv): string[] {
  const configured = env[EXPORT_ROOTS_VARIABLE]?.trim() || env[SHARED_ROOTS_VARIABLE]?.trim();
  const roots: string[] = [];

  for (const root of (configured ?? "").split(path.delimiter)) {
    const trimmed = root.trim();
    if (trimmed === "") continue;
    if (!path.isAbsolute(trimmed)) {
      throw new Civil3DRpcError(
        `Configured filesystem root must be absolute: ${trimmed}`,
        "CIVIL3D.INVALID_CONFIGURATION",
        -32000,
      );
    }
    roots.push(path.resolve(trimmed));
  }

  if (roots.length === 0) {
    // The plugin falls back to the user's Documents folder.
    roots.push(path.join(os.homedir(), "Documents"));
  }

  return [...new Set(roots)];
}

function isWithinRoot(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  if (relative === "") return true;
  if (path.isAbsolute(relative)) return false;
  if (relative === "..") return false;
  return !relative.startsWith(`..${path.sep}`);
}

function rejectPathLinks(candidate: string, root: string): void {
  const relative = path.relative(root, candidate);
  if (relative === "") return;

  let current = root;
  for (const segment of relative.split(path.sep)) {
    if (segment === "") continue;
    current = path.join(current, segment);
    if (!existsSync(current)) break;

    try {
      if (lstatSync(current).isSymbolicLink()) {
        throw new Civil3DRpcError(
          `Filesystem links and junctions are not allowed in caller-supplied paths: ${current}`,
          "CIVIL3D.PATH_NOT_ALLOWED",
          -32040,
        );
      }
    } catch (error) {
      if (error instanceof Civil3DRpcError) throw error;
      throw new Civil3DRpcError(
        `Unable to validate filesystem path '${current}': ${errorMessage(error)}`,
        "CIVIL3D.FILE_IO_ERROR",
        -32000,
      );
    }
  }
}

function normalizeExtension(extension: string): string {
  return (extension.startsWith(".") ? extension : `.${extension}`).toLowerCase();
}

function invalidInput(message: string): Civil3DRpcError {
  return new Civil3DRpcError(message, "CIVIL3D.INVALID_INPUT", -32602);
}

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
