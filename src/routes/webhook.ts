import { Hono } from "hono";
import { ObjectId } from "mongodb";
import { minimatch } from "minimatch";
import { collections } from "../db/client.js";
import { verifyGithubSignature, type WebhookVariables } from "../middleware/verify-github-signature.js";
import { GithubService } from "../services/github.service.js";
import { DeepseekService } from "../services/deepseek.service.js";
import { getInstallationOctokit } from "../services/github-app.service.js";
import { getRepoReviewConfig } from "../services/codessa-config.service.js";
import { getPatchLineContents, resolveCommentLine } from "../utils/diff.js";
import type { ReviewAnalysisFocus } from "../constants/review-config.js";

const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET ?? "";
const deepseekApiKey = process.env.DEEPSEEK_API_KEY ?? "";

const SEVERITY_LABELS: Record<string, string> = {
  critical: "🔴 Critical",
  major: "🟠 Major",
  minor: "🟡 Minor",
  info: "🔵 Info",
};

function buildInlineCommentBody(severity: string, comment: string, suggestion?: string | null): string {
  const label = SEVERITY_LABELS[severity] ?? severity;
  const body = `**${label}** — ${comment}`;
  return suggestion ? `${body}\n\n\`\`\`suggestion\n${suggestion}\n\`\`\`` : body;
}

function buildReviewBody(summary: string, changes: string[] | undefined, unplacedComments: { file: string; severity: string; comment: string }[]): string {
  const sections = ["## Codessa Review", "", summary];

  if (changes?.length) {
    sections.push("", "**Changes:**", ...changes.map((change) => `- ${change}`));
  }

  if (unplacedComments.length) {
    sections.push(
      "",
      "---",
      "**Additional notes:**",
      ...unplacedComments.map((c) => `- **${SEVERITY_LABELS[c.severity] ?? c.severity}** \`${c.file}\`: ${c.comment}`)
    );
  }

  return sections.join("\n");
}

export const webhookRoute = new Hono<{ Variables: WebhookVariables }>();

webhookRoute.post("/github", verifyGithubSignature(webhookSecret), async (c) => {
  const event = c.req.header("x-github-event");
  const rawBody = c.get("rawBody");
  const payload = JSON.parse(rawBody);

  if (event === "installation") {
    await handleInstallationEvent(payload);
    return c.json({ ok: true });
  }

  if (event !== "pull_request" || !["opened", "synchronize", "reopened"].includes(payload.action)) {
    return c.json({ skipped: true });
  }

  const fullName = payload.repository.full_name as string;
  const [owner, repo] = fullName.split("/");
  const pullNumber = payload.pull_request.number as number;
  const commitSha = payload.pull_request.head.sha as string;
  const installationId = payload.installation?.id as number | undefined;

  if (!installationId) {
    return c.json({ skipped: true, reason: "no installation in payload" });
  }

  const repository = await collections.repositories.findOne({ fullName, enabled: true });
  if (!repository) {
    return c.json({ skipped: true, reason: "repository not enabled" });
  }

  const existing = await collections.reviews.findOne({ repositoryId: repository._id, commitSha });
  if (existing) {
    return c.json({ skipped: true, reason: "already reviewed this commit" });
  }

  const { insertedId } = await collections.reviews.insertOne({
    repositoryId: repository._id as ObjectId,
    pullNumber,
    commitSha,
    status: "running",
    comments: [],
    createdAt: new Date(),
  });

  const repoOwner = await collections.users.findOne({ _id: repository.userId });

  runReview({
    owner,
    repo,
    pullNumber,
    commitSha,
    reviewId: insertedId,
    installationId,
    customInstructions: repository.customInstructions,
    excludePaths: repository.excludePaths,
    tone: repository.tone,
    severityThreshold: repository.severityThreshold,
    analysisFocus: repository.analysisFocus,
    reviewLanguage: repoOwner?.settings?.reviewLanguage,
    userTone: repoOwner?.settings?.tone,
    userCustomInstructions: repoOwner?.settings?.customInstructions,
  }).catch((error) => {
    console.error("runReview failed:", error);
  });

  return c.json({ accepted: true, reviewId: insertedId });
});

async function handleInstallationEvent(payload: { action: string; installation: { id: number } }) {
  const installationId = payload.installation.id;

  if (payload.action === "deleted") {
    await collections.installations.deleteOne({ installationId });
    await collections.repositories.updateMany({ installationId }, { $set: { enabled: false } });
  } else if (payload.action === "suspend") {
    await collections.installations.updateOne({ installationId }, { $set: { suspendedAt: new Date() } });
    await collections.repositories.updateMany({ installationId }, { $set: { enabled: false } });
  } else if (payload.action === "unsuspend") {
    await collections.installations.updateOne({ installationId }, { $unset: { suspendedAt: "" } });
  }
}

async function runReview(params: {
  owner: string;
  repo: string;
  pullNumber: number;
  commitSha: string;
  reviewId: ObjectId;
  installationId: number;
  customInstructions?: string;
  excludePaths?: string[];
  tone?: string;
  severityThreshold?: string;
  analysisFocus?: ReviewAnalysisFocus;
  reviewLanguage?: string;
  userTone?: string;
  userCustomInstructions?: string;
}) {
  const deepseek = new DeepseekService(deepseekApiKey);
  const octokit = await getInstallationOctokit(params.installationId);
  const github = new GithubService(octokit);

  let additions = 0;
  let deletions = 0;
  let commitMessage: string | undefined;

  try {
    const config = await getRepoReviewConfig(octokit, params.owner, params.repo);

    if (config?.auto_review === false) {
      await collections.reviews.updateOne(
        { _id: params.reviewId },
        {
          $set: {
            status: "skipped",
            errorMessage: "Review disabled via .github/.codessa.yml (auto_review: false)",
            finishedAt: new Date(),
          },
        }
      );
      return;
    }

    await github.setCommitStatus(params.owner, params.repo, params.commitSha, "pending", "Codessa is reviewing this PR");

    const allFiles = await github.getPullRequestFiles(params.owner, params.repo, params.pullNumber);
    const excludePaths = config?.review_rules?.ignore_paths ?? params.excludePaths ?? [];
    const files = allFiles.filter((f) => !excludePaths.some((pattern) => minimatch(f.filename, pattern, { dot: true })));

    additions = files.reduce((sum, f) => sum + f.additions, 0);
    deletions = files.reduce((sum, f) => sum + f.deletions, 0);
    commitMessage = await github.getCommitMessage(params.owner, params.repo, params.commitSha);

    const severityThreshold = config?.analysis_focus?.severity_threshold ?? params.severityThreshold ?? "balanced";

    const analysisFocus: ReviewAnalysisFocus | undefined =
      config?.analysis_focus || params.analysisFocus
        ? {
            security: config?.analysis_focus?.security ?? params.analysisFocus?.security,
            performance: config?.analysis_focus?.performance ?? params.analysisFocus?.performance,
            bugs: config?.analysis_focus?.bugs ?? params.analysisFocus?.bugs,
            codeStyle: config?.analysis_focus?.code_style ?? params.analysisFocus?.codeStyle,
          }
        : undefined;

    const result = await deepseek.reviewFiles(files, {
      customInstructions: config?.custom_instructions ?? params.customInstructions ?? params.userCustomInstructions,
      language: config?.language ?? params.reviewLanguage,
      tone: config?.tone ?? params.tone ?? params.userTone,
      analysisFocus,
    });

    const reportedComments =
      severityThreshold === "critical_only" ? result.comments.filter((c) => c.severity === "critical") : result.comments;

    const lineContentsByFile = new Map(
      files.map((f) => [f.filename, f.patch ? getPatchLineContents(f.patch) : new Map<number, string>()])
    );
    const resolvedComments = reportedComments.map((c) => ({
      ...c,
      resolvedLine: resolveCommentLine(lineContentsByFile.get(c.file) ?? new Map(), c.line, c.lineContent),
    }));

    const comments = resolvedComments.map((c) => ({
      filePath: c.file,
      line: c.resolvedLine,
      severity: c.severity,
      comment: c.comment,
    }));

    const inlineComments = resolvedComments
      .filter((c) => c.resolvedLine !== null)
      .map((c) => ({
        path: c.file,
        line: c.resolvedLine as number,
        body: buildInlineCommentBody(c.severity, c.comment, c.suggestion),
      }));

    const unplacedComments = resolvedComments.filter((c) => c.resolvedLine === null);
    const summary = buildReviewBody(result.summary, result.changes, unplacedComments);

    await github.postReviewComment(params.owner, params.repo, params.pullNumber, summary, inlineComments);

    const shouldFail =
      severityThreshold === "strict"
        ? reportedComments.some((c) => c.severity === "critical" || c.severity === "major")
        : reportedComments.some((c) => c.severity === "critical");

    await github.setCommitStatus(
      params.owner,
      params.repo,
      params.commitSha,
      shouldFail ? "failure" : "success",
      shouldFail ? "Codessa found issues that need attention" : "Codessa review complete"
    );

    await collections.reviews.updateOne(
      { _id: params.reviewId },
      {
        $set: {
          status: "success",
          verdict: shouldFail ? "issues_found" : "passed",
          summary: result.summary,
          comments,
          commitMessage,
          additions,
          deletions,
          finishedAt: new Date(),
        },
      }
    );
  } catch (error) {
    try {
      await github.setCommitStatus(params.owner, params.repo, params.commitSha, "error", "Codessa review failed");
    } catch {
      // commit status update can fail too (e.g. installation revoked mid-flight); review failure is recorded below regardless
    }

    await collections.reviews.updateOne(
      { _id: params.reviewId },
      {
        $set: {
          status: "failed",
          verdict: "error",
          errorMessage: error instanceof Error ? error.message : String(error),
          commitMessage,
          additions,
          deletions,
          finishedAt: new Date(),
        },
      }
    );
  }
}
