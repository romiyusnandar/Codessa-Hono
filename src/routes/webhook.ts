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
import { isSupportedCodeFile } from "../constants/supported-code-languages.js";
import { scanDependencies } from "../services/sca.service.js";
import { computeCvssScore } from "../utils/cvss.js";
import type { ReviewComment } from "../db/models.js";

const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET ?? "";
const deepseekApiKey = process.env.DEEPSEEK_API_KEY ?? "";

/** Any finding at or above this CVSS score fails the PR's status check, regardless of severityThreshold. */
const CVSS_FAIL_THRESHOLD = 7.0;

const SEVERITY_LABELS: Record<string, string> = {
  critical: "🔴 Critical",
  major: "🟠 Major",
  minor: "🟡 Minor",
  info: "🔵 Info",
};

type UnifiedFinding = {
  file: string;
  resolvedLine: number | null;
  severity: ReviewComment["severity"];
  comment: string;
  suggestion?: string | null;
  source: "ai" | "sca";
  cwe?: { id: string; name: string } | null;
  cvss?: { vector: string; score: number } | null;
  vulnerabilityId?: string | null;
};

function buildInlineCommentBody(finding: UnifiedFinding): string {
  const label = SEVERITY_LABELS[finding.severity] ?? finding.severity;
  const tags = [
    finding.cwe ? `\`${finding.cwe.id}\` ${finding.cwe.name}` : null,
    finding.cvss ? `CVSS ${finding.cvss.score.toFixed(1)}` : null,
  ].filter(Boolean);

  const header = tags.length ? `**${label}** (${tags.join(" · ")}) — ${finding.comment}` : `**${label}** — ${finding.comment}`;
  return finding.suggestion ? `${header}\n\n\`\`\`suggestion\n${finding.suggestion}\n\`\`\`` : header;
}

function buildReviewBody(summary: string, changes: string[] | undefined, unplacedFindings: UnifiedFinding[]): string {
  const sections = ["## Codessa Review", "", summary];

  if (changes?.length) {
    sections.push("", "**Changes:**", ...changes.map((change) => `- ${change}`));
  }

  if (unplacedFindings.length) {
    sections.push(
      "",
      "---",
      "**Additional notes:**",
      ...unplacedFindings.map((f) => `- **${SEVERITY_LABELS[f.severity] ?? f.severity}** \`${f.file}\`: ${f.comment}`)
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
    // AI review is scoped to a fixed set of languages (PHP/JS/TS/Go/Python); other files
    // (e.g. manifest files, YAML, CSS) are excluded here but still counted in additions/deletions
    // and still considered by the SCA layer below.
    const reviewableFiles = files.filter((f) => isSupportedCodeFile(f.filename));

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

    const result = reviewableFiles.length
      ? await deepseek.reviewFiles(reviewableFiles, {
          customInstructions: config?.custom_instructions ?? params.customInstructions ?? params.userCustomInstructions,
          language: config?.language ?? params.reviewLanguage,
          tone: config?.tone ?? params.tone ?? params.userTone,
          analysisFocus,
        })
      : { summary: "No PHP, JavaScript, Go, or Python files changed in this PR — nothing for the AI to review.", changes: [], comments: [] };

    const reportedComments =
      severityThreshold === "critical_only" ? result.comments.filter((c) => c.severity === "critical") : result.comments;

    const lineContentsByFile = new Map(
      files.map((f) => [f.filename, f.patch ? getPatchLineContents(f.patch) : new Map<number, string>()])
    );

    const aiFindings: UnifiedFinding[] = reportedComments.map((c) => {
      const cvssResult = c.cvssVector ? computeCvssScore(c.cvssVector) : null;
      return {
        file: c.file,
        resolvedLine: resolveCommentLine(lineContentsByFile.get(c.file) ?? new Map(), c.line, c.lineContent),
        severity: c.severity,
        comment: c.comment,
        suggestion: c.suggestion,
        source: "ai",
        cwe: c.cweId && c.cweName ? { id: c.cweId, name: c.cweName } : null,
        cvss: cvssResult ? { vector: cvssResult.vector, score: cvssResult.score } : null,
      };
    });

    // Layer 1 (SCA): only runs when security analysis is enabled — deterministic CVE data
    // from OSV.dev, not AI-derived. Scoped to the 4 supported ecosystems (npm/PyPI/Packagist/Go).
    const securityFocusEnabled = analysisFocus?.security !== false;
    const scaFindings: UnifiedFinding[] = securityFocusEnabled
      ? (await scanDependencies(octokit, params.owner, params.repo, params.commitSha, files)).map((f) => ({
          file: f.file,
          resolvedLine: f.line,
          severity: f.severity,
          comment: f.comment,
          source: "sca",
          cvss: f.cvss ? { vector: f.cvss.vector, score: f.cvss.score } : null,
          vulnerabilityId: f.vulnerabilityId,
        }))
      : [];

    const allFindings = [...aiFindings, ...scaFindings];

    const comments: ReviewComment[] = allFindings.map((f) => ({
      filePath: f.file,
      line: f.resolvedLine,
      severity: f.severity,
      comment: f.comment,
      source: f.source,
      cwe: f.cwe ?? null,
      cvss: f.cvss ?? null,
      vulnerabilityId: f.vulnerabilityId ?? null,
    }));

    const inlineComments = allFindings
      .filter((f) => f.resolvedLine !== null)
      .map((f) => ({ path: f.file, line: f.resolvedLine as number, body: buildInlineCommentBody(f) }));

    const unplacedFindings = allFindings.filter((f) => f.resolvedLine === null);
    const summary = buildReviewBody(result.summary, result.changes, unplacedFindings);

    await github.postReviewComment(params.owner, params.repo, params.pullNumber, summary, inlineComments);

    const hasSeverityFailure =
      severityThreshold === "strict"
        ? reportedComments.some((c) => c.severity === "critical" || c.severity === "major")
        : reportedComments.some((c) => c.severity === "critical");
    const hasHighCvss = allFindings.some((f) => (f.cvss?.score ?? 0) >= CVSS_FAIL_THRESHOLD);
    const shouldFail = hasSeverityFailure || hasHighCvss;

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
