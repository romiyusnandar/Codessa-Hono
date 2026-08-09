import { z } from "zod";
import type { PullRequestFile } from "./github.service.js";
import { annotatePatchWithLineNumbers } from "../utils/diff.js";
import { getLanguageLabel } from "../constants/languages.js";

const reviewCommentSchema = z.object({
  file: z.string(),
  line: z.number().nullable(),
  lineContent: z.string().nullable().optional(),
  severity: z.enum(["info", "minor", "major", "critical"]),
  comment: z.string(),
  suggestion: z.string().nullable().optional(),
  cweId: z.string().nullable().optional(),
  cweName: z.string().nullable().optional(),
  cvssVector: z.string().nullable().optional(),
});

const reviewResultSchema = z.object({
  summary: z.string(),
  changes: z.array(z.string()).optional(),
  comments: z.array(reviewCommentSchema),
});

export type ReviewResult = z.infer<typeof reviewResultSchema>;

const SYSTEM_PROMPT = `You are Codessa, an expert code reviewer for pull requests written in PHP, JavaScript/TypeScript, Go, or Python.
Review the provided diff and respond ONLY with valid JSON matching this shape:
{
  "summary": string,
  "changes": string[],
  "comments": [
    { "file": string, "line": number | null, "lineContent": string | null, "severity": "info" | "minor" | "major" | "critical", "comment": string, "suggestion": string | null, "cweId": string | null, "cweName": string | null, "cvssVector": string | null }
  ]
}
Focus on bugs, security issues, performance, and maintainability.

"summary" is a short 1-2 sentence high-level assessment of the PR as a whole.

"changes" is a bullet list of what the PR actually changes, written as an array of short plain strings (no leading "-" or bullet character, that's added by the renderer). List roughly 2-6 items covering the meaningful changes visible in the diff, e.g. "Switched the default MODEL to a different Hugging Face reference" or "Reduced NUM_CTX from 16384 to 8192 tokens". Use an empty array only if there's truly nothing worth listing separately from "summary".

Each diff line is prefixed with its exact line number in the NEW version of the file, followed by the original "+"/"-"/" " marker, e.g. "12+    return a - b;". Removed lines (marker "-") have no line number since they don't exist in the new file. Always copy the given line number exactly for the "line" field — do not count or recalculate it yourself. If a comment refers to a removed line or can't be tied to a specific numbered line, set "line" to null.

For "lineContent", copy the exact source code text of that same line verbatim (everything after the line number and the "+"/"-"/" " marker), trimmed of leading/trailing whitespace, exactly as it appears in the diff — do not paraphrase or retype it from memory. This is used to double-check you picked the right line, which matters most when multiple lines look similar (e.g. duplicate "break;" statements). Set "lineContent" to null whenever "line" is null.

For "suggestion", provide the complete replacement code for that single line ONLY when you have a concrete, safe, single-line fix you're confident about and "line" is not null — just the raw code for that one line, no diff marker, no line number, no markdown fences (those are added for you). Never propose a multi-line change here. Set "suggestion" to null whenever you don't have a precise single-line fix, including for design/architecture feedback, questions, or anything requiring more than one line to fix.

For genuine security vulnerabilities only (e.g. injection, auth bypass, path traversal, SSRF, insecure deserialization, hardcoded secrets, unsafe crypto — not general bugs or style issues), also fill in:
- "cweId": the CWE identifier, e.g. "CWE-89" for SQL injection.
- "cweName": the CWE's official short name, e.g. "SQL Injection".
- "cvssVector": your best-effort CVSS v4.0 vector (the current FIRST standard) reflecting the vulnerability's exploitability and impact IN THIS SPECIFIC CODE CONTEXT, formatted exactly as "CVSS:4.0/AV:x/AC:x/AT:x/PR:x/UI:x/VC:x/VI:x/VA:x/SC:x/SI:x/SA:x" with one of the valid values for each metric (AV: N/A/L/P, AC: L/H, AT: N/P, PR: N/L/H, UI: N/P/A, VC/VI/VA/SC/SI/SA: H/L/N). If you're not confident enough in the v4.0 metrics for this case, a CVSS v3.1 vector ("CVSS:3.1/AV:x/AC:x/PR:x/UI:x/S:x/C:x/I:x/A:x") is also accepted. You are proposing the vector only — the system computes the actual numeric score from it independently, so focus on picking accurate metric values, not on estimating a score yourself.
Set all three of "cweId", "cweName", "cvssVector" to null together for anything that isn't a specific, nameable security vulnerability — most comments (style, performance, ordinary bugs) should leave these null.

Never mention a line number inside the "comment" text itself (e.g. don't write "(line 12)" or "(baris 12)") — the comment is already anchored to the correct line via the "line" field, and repeating the number in prose risks it not matching. Just describe the issue directly. Do not include markdown fences in your response.`;

const TONE_INSTRUCTIONS: Record<string, string> = {
  friendly: "Write comments in a friendly, encouraging tone, as a supportive teammate would.",
  strict: "Write comments in a strict, no-nonsense tone. Be direct about problems, don't soften criticism.",
  concise: "Write comments as concisely as possible — short sentences, no filler, straight to the point.",
};

export type AnalysisFocus = {
  security?: boolean;
  performance?: boolean;
  bugs?: boolean;
  codeStyle?: boolean;
};

const FOCUS_LABELS: Record<keyof AnalysisFocus, string> = {
  security: "security issues",
  performance: "performance issues",
  bugs: "bugs and correctness issues",
  codeStyle: "code style and maintainability",
};

function buildFocusInstruction(focus?: AnalysisFocus): string | null {
  if (!focus) return null;

  const included = (Object.keys(FOCUS_LABELS) as (keyof AnalysisFocus)[]).filter((key) => focus[key] !== false);
  const excluded = (Object.keys(FOCUS_LABELS) as (keyof AnalysisFocus)[]).filter((key) => focus[key] === false);

  if (excluded.length === 0) return null;

  if (included.length === 0) {
    return "No analysis focus areas are enabled; fall back to a general review covering bugs, security, performance, and maintainability.";
  }

  return `Focus your review specifically on: ${included.map((k) => FOCUS_LABELS[k]).join(", ")}. Do not comment on ${excluded
    .map((k) => FOCUS_LABELS[k])
    .join(", ")}.`;
}

export class DeepseekService {
  private apiKey: string;
  private baseUrl = "https://api.deepseek.com";

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async reviewFiles(
    files: PullRequestFile[],
    options?: { customInstructions?: string; language?: string; tone?: string; analysisFocus?: AnalysisFocus }
  ): Promise<ReviewResult> {
    const diffText = files
      .filter((f) => f.patch)
      .map((f) => `### File: ${f.filename} (${f.status})\n${annotatePatchWithLineNumbers(f.patch!)}`)
      .join("\n\n");

    const language = getLanguageLabel(options?.language);

    const instructions = [
      `Write the "summary" and all "comment" text in ${language}.`,
      options?.tone ? TONE_INSTRUCTIONS[options.tone] ?? null : null,
      buildFocusInstruction(options?.analysisFocus),
      options?.customInstructions ?? null,
    ]
      .filter(Boolean)
      .join("\n\n");

    const userPrompt = instructions ? `${instructions}\n\nDiff to review:\n${diffText}` : `Diff to review:\n${diffText}`;

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: "deepseek-v4-flash",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
        response_format: { type: "json_object" },
        temperature: 0.2,
      }),
    });

    if (!response.ok) {
      throw new Error(`DeepSeek API error: ${response.status} ${await response.text()}`);
    }

    const data = (await response.json()) as { choices: { message: { content: string } }[] };
    const content = data.choices[0].message.content;
    return reviewResultSchema.parse(JSON.parse(content));
  }
}
