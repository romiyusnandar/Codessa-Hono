import { load } from "js-yaml";
import { z } from "zod";
import type { Octokit } from "octokit";
import { SUPPORTED_LANGUAGES } from "../constants/languages.js";
import { REVIEW_TONES, SEVERITY_THRESHOLDS } from "../constants/review-config.js";

const CONFIG_PATH = ".github/.codessa.yml";
const supportedLanguageCodes = SUPPORTED_LANGUAGES.map((l) => l.code) as [string, ...string[]];

const codessaConfigSchema = z.object({
  version: z.union([z.string(), z.number()]).optional(),
  auto_review: z.boolean().optional(),
  language: z.enum(supportedLanguageCodes).optional(),
  tone: z.enum(REVIEW_TONES).optional(),
  review_rules: z
    .object({
      ignore_paths: z.array(z.string()).optional(),
    })
    .optional(),
  analysis_focus: z
    .object({
      security: z.boolean().optional(),
      performance: z.boolean().optional(),
      bugs: z.boolean().optional(),
      code_style: z.boolean().optional(),
      severity_threshold: z.enum(SEVERITY_THRESHOLDS).optional(),
    })
    .optional(),
  custom_instructions: z.string().optional(),
});

export type CodessaConfig = z.infer<typeof codessaConfigSchema>;

/**
 * Always reads from the repo's default branch (no ref passed to getContent),
 * so a PR author can't smuggle config changes through their own branch/fork.
 */
export async function getRepoReviewConfig(octokit: Octokit, owner: string, repo: string): Promise<CodessaConfig | null> {
  let raw: string;

  try {
    const { data } = await octokit.rest.repos.getContent({ owner, repo, path: CONFIG_PATH });
    if (Array.isArray(data) || data.type !== "file" || !("content" in data)) {
      return null;
    }
    raw = Buffer.from(data.content, "base64").toString("utf-8");
  } catch (error) {
    if (error && typeof error === "object" && "status" in error && error.status === 404) {
      return null;
    }
    console.warn(`Failed to fetch ${CONFIG_PATH} for ${owner}/${repo}:`, error);
    return null;
  }

  let parsed: unknown;
  try {
    parsed = load(raw);
  } catch (error) {
    console.warn(`Failed to parse ${CONFIG_PATH} for ${owner}/${repo}:`, error);
    return null;
  }

  const result = codessaConfigSchema.safeParse(parsed);
  if (!result.success) {
    console.warn(`Invalid ${CONFIG_PATH} for ${owner}/${repo}:`, result.error.message);
    return null;
  }

  return result.data;
}
