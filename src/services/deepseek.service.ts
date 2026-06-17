import { z } from "zod";
import type { PullRequestFile } from "./github.service.js";

const reviewCommentSchema = z.object({
  file: z.string(),
  line: z.number().nullable(),
  severity: z.enum(["info", "minor", "major", "critical"]),
  comment: z.string(),
});

const reviewResultSchema = z.object({
  summary: z.string(),
  comments: z.array(reviewCommentSchema),
});

export type ReviewResult = z.infer<typeof reviewResultSchema>;

const SYSTEM_PROMPT = `You are Codessa, an expert code reviewer for pull requests written in any programming language.
Review the provided diff and respond ONLY with valid JSON matching this shape:
{
  "summary": string,
  "comments": [
    { "file": string, "line": number | null, "severity": "info" | "minor" | "major" | "critical", "comment": string }
  ]
}
Focus on bugs, security issues, performance, and maintainability. Use "line" as the line number in the new file version, or null if it cannot be mapped to a specific line. Do not include markdown fences in your response.`;

export class DeepseekService {
  private apiKey: string;
  private baseUrl = "https://api.deepseek.com";

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async reviewFiles(files: PullRequestFile[], customInstructions?: string): Promise<ReviewResult> {
    const diffText = files
      .filter((f) => f.patch)
      .map((f) => `### File: ${f.filename} (${f.status})\n${f.patch}`)
      .join("\n\n");

    const userPrompt = customInstructions
      ? `${customInstructions}\n\nDiff to review:\n${diffText}`
      : `Diff to review:\n${diffText}`;

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
