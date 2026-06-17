const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function getValidCommentLines(patch: string): Set<number> {
  const validLines = new Set<number>();
  let newLine = 0;

  for (const line of patch.split("\n")) {
    const hunkMatch = line.match(HUNK_HEADER);
    if (hunkMatch) {
      newLine = Number(hunkMatch[1]);
      continue;
    }

    if (line.startsWith("+")) {
      validLines.add(newLine);
      newLine++;
    } else if (line.startsWith("-")) {
      // removed line, doesn't exist in the new file, line counter doesn't advance
    } else if (!line.startsWith("\\")) {
      // context line, exists in both old and new file
      validLines.add(newLine);
      newLine++;
    }
  }

  return validLines;
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
