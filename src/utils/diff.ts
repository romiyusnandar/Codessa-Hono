const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * Maps every commentable line number (added or context) in the NEW version of
 * the file to its trimmed source text, so an AI-claimed line can be cross-checked
 * against what's actually there instead of just "is this a real diff line".
 */
export function getPatchLineContents(patch: string): Map<number, string> {
  const contents = new Map<number, string>();
  let newLine = 0;

  for (const line of patch.split("\n")) {
    const hunkMatch = line.match(HUNK_HEADER);
    if (hunkMatch) {
      newLine = Number(hunkMatch[1]);
      continue;
    }

    if (line.startsWith("+")) {
      contents.set(newLine, line.slice(1).trim());
      newLine++;
    } else if (line.startsWith("-")) {
      // removed line, doesn't exist in the new file, line counter doesn't advance
    } else if (!line.startsWith("\\")) {
      // context line, exists in both old and new file
      contents.set(newLine, line.slice(1).trim());
      newLine++;
    }
  }

  return contents;
}

/**
 * Resolves the line an AI review comment should actually be anchored to.
 * The model is asked to copy the exact source text of the line it means (lineContent)
 * alongside the line number it counted — LLMs miscount lines far more often than they
 * miscopy text, especially with duplicate-looking lines (e.g. two "break;" additions).
 * If the claimed line's real content doesn't match, we look for a line that does,
 * preferring the one closest to the claimed line number to disambiguate duplicates.
 */
export function resolveCommentLine(
  lineContents: Map<number, string>,
  claimedLine: number | null,
  lineContent: string | null | undefined
): number | null {
  if (claimedLine === null) return null;

  const normalizedClaim = lineContent?.trim();
  if (!normalizedClaim) {
    return lineContents.has(claimedLine) ? claimedLine : null;
  }

  if (lineContents.get(claimedLine) === normalizedClaim) {
    return claimedLine;
  }

  const matches = [...lineContents.entries()].filter(([, content]) => content === normalizedClaim);
  if (matches.length === 0) {
    return lineContents.has(claimedLine) ? claimedLine : null;
  }

  matches.sort((a, b) => Math.abs(a[0] - claimedLine) - Math.abs(b[0] - claimedLine));
  return matches[0][0];
}

export function annotatePatchWithLineNumbers(patch: string): string {
  let newLine = 0;
  const output: string[] = [];

  for (const line of patch.split("\n")) {
    const hunkMatch = line.match(HUNK_HEADER);
    if (hunkMatch) {
      newLine = Number(hunkMatch[1]);
      output.push(line);
      continue;
    }

    if (line.startsWith("+")) {
      output.push(`${newLine}${line}`);
      newLine++;
    } else if (line.startsWith("-")) {
      output.push(`     ${line}`);
    } else if (!line.startsWith("\\")) {
      output.push(`${newLine}${line}`);
      newLine++;
    } else {
      output.push(line);
    }
  }

  return output.join("\n");
}
