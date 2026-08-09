import { Hono } from "hono";
import { ObjectId } from "mongodb";
import { Octokit } from "octokit";
import { z } from "zod";
import { collections } from "../db/client.js";
import { requireAuth, type AuthVariables } from "../middleware/require-auth.js";
import { GithubService } from "../services/github.service.js";
import { DeepseekService } from "../services/deepseek.service.js";
import { scanDependencies } from "../services/sca.service.js";
import { getPatchLineContents, resolveCommentLine } from "../utils/diff.js";
import { computeCvssScore } from "../utils/cvss.js";
import { isSupportedCodeFile } from "../constants/supported-code-languages.js";
import { SUPPORTED_LANGUAGES } from "../constants/languages.js";
import { REVIEW_TONES, SEVERITY_THRESHOLDS } from "../constants/review-config.js";
import type { ReviewComment, TestReview } from "../db/models.js";

/**
 * Ad-hoc PR review testing tool. Intentionally fully self-contained and duplicated
 * from the production pipeline in webhook.ts rather than sharing code with it — this
 * exists purely so a user can experiment against ANY PR they can read (not just repos
 * they've enabled), without ever risking the real review pipeline or posting to GitHub.
 */

const deepseekApiKey = process.env.DEEPSEEK_API_KEY ?? "";
const CVSS_FAIL_THRESHOLD = 7.0; // kept in sync with webhook.ts's CVSS_FAIL_THRESHOLD by convention, not by import

const supportedLanguageCodes = SUPPORTED_LANGUAGES.map((l) => l.code) as [string, ...string[]];

const PR_URL_REGEX = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?(?:[?#].*)?$/;

const testReviewRequestSchema = z.object({
  prUrl: z.string(),
  language: z.enum(supportedLanguageCodes).optional(),
  tone: z.enum(REVIEW_TONES).optional(),
  customInstructions: z.string().max(4000).optional(),
  severityThreshold: z.enum(SEVERITY_THRESHOLDS).optional(),
  analysisFocus: z
    .object({
      security: z.boolean().optional(),
      performance: z.boolean().optional(),
      bugs: z.boolean().optional(),
      codeStyle: z.boolean().optional(),
    })
    .optional(),
});

export const testReviewsRoute = new Hono<{ Variables: AuthVariables }>();

testReviewsRoute.use("*", requireAuth);

testReviewsRoute.post("/", async (c) => {
  const userId = new ObjectId(c.get("userId"));
  const body = await c.req.json().catch(() => null);
  const parsed = testReviewRequestSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: "Invalid payload" }, 400);
  }

  const match = parsed.data.prUrl.match(PR_URL_REGEX);
  if (!match) {
    return c.json({ error: "prUrl must look like https://github.com/{owner}/{repo}/pull/{number}" }, 400);
  }
  const [, owner, repo, pullNumberStr] = match;
  const pullNumber = Number(pullNumberStr);

  const user = await collections.users.findOne({ _id: userId });
  if (!user?.accessToken) {
    return c.json({ error: "No GitHub access token on file — please log in again" }, 401);
  }

  const octokit = new Octokit({ auth: user.accessToken });
  const github = new GithubService(octokit);
  const deepseek = new DeepseekService(deepseekApiKey);

  const base = { userId, prUrl: parsed.data.prUrl, owner, repo, pullNumber };

  try {
    const { data: pr } = await octokit.rest.pulls.get({ owner, repo, pull_number: pullNumber });
    const commitSha = pr.head.sha;
    const commitMessage = await github.getCommitMessage(owner, repo, commitSha);

    const allFiles = await github.getPullRequestFiles(owner, repo, pullNumber);
    const reviewableFiles = allFiles.filter((f) => isSupportedCodeFile(f.filename));
    const additions = allFiles.reduce((sum, f) => sum + f.additions, 0);
    const deletions = allFiles.reduce((sum, f) => sum + f.deletions, 0);

    const securityFocusEnabled = parsed.data.analysisFocus?.security !== false;

    const [result, scaRawFindings] = await Promise.all([
      reviewableFiles.length
        ? deepseek.reviewFiles(reviewableFiles, {
            customInstructions: parsed.data.customInstructions,
            language: parsed.data.language,
            tone: parsed.data.tone,
            analysisFocus: parsed.data.analysisFocus,
          })
        : Promise.resolve({
            summary: "No PHP, JavaScript, Go, or Python files changed in this PR — nothing for the AI to review.",
            changes: [] as string[],
            comments: [] as Awaited<ReturnType<typeof deepseek.reviewFiles>>["comments"],
          }),
      securityFocusEnabled ? scanDependencies(octokit, owner, repo, commitSha, allFiles) : Promise.resolve([]),
    ]);

    const severityThreshold = parsed.data.severityThreshold ?? "balanced";
    const reportedComments =
      severityThreshold === "critical_only" ? result.comments.filter((cm) => cm.severity === "critical") : result.comments;

    const lineContentsByFile = new Map(
      allFiles.map((f) => [f.filename, f.patch ? getPatchLineContents(f.patch) : new Map<number, string>()])
    );

    const aiComments: ReviewComment[] = reportedComments.map((cm) => {
      const cvssResult = cm.cvssVector ? computeCvssScore(cm.cvssVector) : null;
      return {
        filePath: cm.file,
        line: resolveCommentLine(lineContentsByFile.get(cm.file) ?? new Map(), cm.line, cm.lineContent),
        severity: cm.severity,
        comment: cm.comment,
        source: "ai",
        cwe: cm.cweId && cm.cweName ? { id: cm.cweId, name: cm.cweName } : null,
        cvss: cvssResult ? { vector: cvssResult.vector, score: cvssResult.score } : null,
      };
    });

    const scaComments: ReviewComment[] = scaRawFindings.map((f) => ({
      filePath: f.file,
      line: f.line,
      severity: f.severity,
      comment: f.comment,
      source: "sca",
      cvss: f.cvss ? { vector: f.cvss.vector, score: f.cvss.score } : null,
      vulnerabilityId: f.vulnerabilityId,
    }));

    const comments = [...aiComments, ...scaComments];

    const hasSeverityFailure =
      severityThreshold === "strict"
        ? reportedComments.some((cm) => cm.severity === "critical" || cm.severity === "major")
        : reportedComments.some((cm) => cm.severity === "critical");
    const hasHighCvss = comments.some((cm) => (cm.cvss?.score ?? 0) >= CVSS_FAIL_THRESHOLD);
    const shouldFail = hasSeverityFailure || hasHighCvss;

    const testReview: TestReview = {
      ...base,
      commitSha,
      commitMessage,
      additions,
      deletions,
      status: "success",
      verdict: shouldFail ? "issues_found" : "passed",
      summary: result.summary,
      changes: result.changes,
      comments,
      createdAt: new Date(),
      finishedAt: new Date(),
    };

    const { insertedId } = await collections.testReviews.insertOne(testReview);
    return c.json({ id: insertedId, ...testReview });
  } catch (error) {
    const failedReview: TestReview = {
      ...base,
      status: "failed",
      verdict: "error",
      comments: [],
      errorMessage: error instanceof Error ? error.message : String(error),
      createdAt: new Date(),
      finishedAt: new Date(),
    };

    const { insertedId } = await collections.testReviews.insertOne(failedReview);
    return c.json({ id: insertedId, ...failedReview }, 502);
  }
});

testReviewsRoute.get("/:id", async (c) => {
  const userId = new ObjectId(c.get("userId"));
  const id = c.req.param("id");
  if (!ObjectId.isValid(id)) {
    return c.json({ error: "Invalid id" }, 400);
  }

  const review = await collections.testReviews.findOne({ _id: new ObjectId(id), userId });
  if (!review) {
    return c.json({ error: "Not found" }, 404);
  }

  return c.json(review);
});
