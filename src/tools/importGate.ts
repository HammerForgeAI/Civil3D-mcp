/**
 * Item 19 -- the refusal gate for caller-supplied import paths.
 *
 * The plugin's FileBoundary.cs stays the authoritative filesystem boundary: it
 * canonicalizes, checks the configured roots, checks the extension allowlist,
 * refuses reparse points, and finally touches the file. This module is the
 * Node-side half the plan asks for: the two rules a caller can be refused on
 * BEFORE a command reaches the plugin -- the path must be inside the configured
 * import roots, and the extension must be one the action allows. The plugin
 * re-applies both rules; nothing here replaces them.
 *
 * Roots come from the same environment variables FileBoundary reads:
 * CIVIL3D_IMPORT_ROOTS first, then CIVIL3D_FILE_ROOTS as the shared fallback.
 * The variable holds one root per path delimiter (`;` on Windows, `:` elsewhere),
 * exactly like Path.PathSeparator in the plugin.
 *
 * When neither variable is set there is no configured root a path can be outside
 * of, so only the extension rule is enforced and the caller's own string is
 * returned unchanged -- the plugin then applies its own boundary and its own
 * fallback root. When a root IS configured, an import path must be absolute,
 * which is what Path.IsPathFullyQualified requires in the plugin.
 *
 * Deliberately free of MCP/zod imports so fase1Build.ts stays unit-testable with
 * a fake `send`.
 */
import path from "node:path";

export const FILE_ROOTS_VARIABLE = "CIVIL3D_FILE_ROOTS";
export const IMPORT_ROOTS_VARIABLE = "CIVIL3D_IMPORT_ROOTS";
export const EXPORT_ROOTS_VARIABLE = "CIVIL3D_EXPORT_ROOTS";

/** The plugin's own domain error codes, reused so the caller sees one vocabulary on both sides. */
export type ImportGateCode =
  | "CIVIL3D.INVALID_INPUT"
  | "CIVIL3D.PATH_NOT_ALLOWED"
  | "CIVIL3D.FILE_TYPE_NOT_ALLOWED";

export class ImportPathRefusedError extends Error {
  readonly code: ImportGateCode;
  /** The caller's path exactly as it was supplied (never the canonicalized one). */
  readonly refusedPath: string;

  constructor(code: ImportGateCode, message: string, refusedPath: string) {
    super(message);
    this.name = "ImportPathRefusedError";
    this.code = code;
    this.refusedPath = refusedPath;
  }
}

/**
 * The configured import roots, in the order FileBoundary resolves them:
 * CIVIL3D_IMPORT_ROOTS, then the shared CIVIL3D_FILE_ROOTS. An unset or blank
 * variable yields an empty list (no root is configured, so nothing is enforced).
 */
export function configuredImportRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const importRoots = env[IMPORT_ROOTS_VARIABLE];
  const configured = importRoots !== undefined && importRoots.trim() !== ""
    ? importRoots
    : env[FILE_ROOTS_VARIABLE];

  if (configured === undefined) return [];

  return configured
    .split(path.delimiter)
    .map((root) => root.trim())
    .filter((root) => root.length > 0);
}

/** `Path.GetRelativePath(root, path)` cannot start above, or at, the root. */
export function isWithinRoot(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  if (relative === "" || relative === ".") return true;
  if (path.isAbsolute(relative)) return false;
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !relative.startsWith("../");
}

function normalizeExtension(extension: string): string {
  return extension.startsWith(".") ? extension.toLowerCase() : `.${extension.toLowerCase()}`;
}

/**
 * Refuse or accept one caller-supplied import path.
 *
 * Returns the path to hand to the plugin: the canonicalized absolute path when
 * import roots are configured, otherwise the caller's string unchanged. Throws
 * ImportPathRefusedError -- never a bare Error -- so the caller can report the
 * plugin's own error code.
 *
 * @param rawPath          the caller-supplied path
 * @param allowedExtensions the extensions this action accepts (with or without
 *                          the leading dot); an empty list enforces no extension
 * @param env              the environment to read the roots from (injectable for tests)
 */
export function resolveGatedImportPath(
  rawPath: string,
  allowedExtensions: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (typeof rawPath !== "string" || rawPath.trim() === "") {
    throw new ImportPathRefusedError("CIVIL3D.INVALID_INPUT", "A non-empty import path is required.", String(rawPath));
  }

  const roots = configuredImportRoots(env);
  const canonicalPath = path.resolve(rawPath);

  if (roots.length > 0) {
    if (!path.isAbsolute(rawPath)) {
      throw new ImportPathRefusedError(
        "CIVIL3D.INVALID_INPUT",
        `The import path must be absolute: ${rawPath}`,
        rawPath,
      );
    }

    if (!roots.some((root) => isWithinRoot(canonicalPath, path.resolve(root)))) {
      throw new ImportPathRefusedError(
        "CIVIL3D.PATH_NOT_ALLOWED",
        `The import path is outside the configured roots: ${canonicalPath}`,
        rawPath,
      );
    }
  }

  const allowed = new Set(allowedExtensions.map(normalizeExtension));
  const extension = path.extname(canonicalPath).toLowerCase();
  if (allowed.size > 0 && !allowed.has(extension)) {
    throw new ImportPathRefusedError(
      "CIVIL3D.FILE_TYPE_NOT_ALLOWED",
      `Extension '${extension}' is not allowed for this operation. Allowed extensions: ${[...allowed].sort().join(", ")}.`,
      rawPath,
    );
  }

  return roots.length > 0 ? canonicalPath : rawPath;
}
