/**
 * Programming languages Codessa's AI review is scoped to. Files outside these
 * extensions are skipped from AI review entirely (still visible in additions/deletions
 * counts, just not sent to the model) — this keeps prompt behavior and the security
 * findings (CWE/CVSS) predictable and tested only for languages we actually support.
 */
export const SUPPORTED_CODE_EXTENSIONS = new Set([
  ".php",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".go",
  ".py",
]);

export function isSupportedCodeFile(filename: string): boolean {
  const dot = filename.lastIndexOf(".");
  if (dot === -1) return false;
  return SUPPORTED_CODE_EXTENSIONS.has(filename.slice(dot).toLowerCase());
}
