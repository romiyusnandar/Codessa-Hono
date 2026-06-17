import { Hono } from "hono";
import { ObjectId } from "mongodb";
import { collections } from "../db/client.js";
import { verifyGithubSignature, type WebhookVariables } from "../middleware/verify-github-signature.js";
import { GithubService } from "../services/github.service.js";
import { DeepseekService } from "../services/deepseek.service.js";
import { getInstallationOctokit } from "../services/github-app.service.js";
import { getValidCommentLines } from "../utils/diff.js";

const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET ?? "";
const deepseekApiKey = process.env.DEEPSEEK_API_KEY ?? "";

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

  runReview({
    owner,
    repo,
    pullNumber,
    commitSha,
    reviewId: insertedId,
    installationId,
    customInstructions: repository.customInstructions,
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
}) {
  const deepseek = new DeepseekService(deepseekApiKey);
  const octokit = await getInstallationOctokit(params.installationId);
  const github = new GithubService(octokit);

  try {
    await github.setCommitStatus(params.owner, params.repo, params.commitSha, "pending", "Codessa is reviewing this PR");

    const files = await github.getPullRequestFiles(params.owner, params.repo, params.pullNumber);
    const result = await deepseek.reviewFiles(files, params.customInstructions);

    const validLinesByFile = new Map(files.map((f) => [f.filename, f.patch ? getValidCommentLines(f.patch) : new Set<number>()]));
    const isLineValid = (file: string, line: number | null) =>
      line !== null && (validLinesByFile.get(file)?.has(line) ?? false);

    const comments = result.comments.map((c) => ({
      filePath: c.file,
      line: c.line,
      severity: c.severity,
      comment: c.comment,
    }));

    const inlineComments = result.comments
      .filter((c) => isLineValid(c.file, c.line))
      .map((c) => ({ path: c.file, line: c.line as number, body: `**[${c.severity}]** ${c.comment}` }));

    const unplacedComments = result.comments.filter((c) => !isLineValid(c.file, c.line));
    const summary = unplacedComments.length
      ? `${result.summary}\n\n---\n**Additional notes:**\n${unplacedComments
          .map((c) => `- **[${c.severity}]** \`${c.file}\`: ${c.comment}`)
          .join("\n")}`
      : result.summary;

    await github.postReviewComment(params.owner, params.repo, params.pullNumber, summary, inlineComments);

    const hasCritical = result.comments.some((c) => c.severity === "critical");
    await github.setCommitStatus(
      params.owner,
      params.repo,
      params.commitSha,
      hasCritical ? "failure" : "success",
      hasCritical ? "Codessa found critical issues" : "Codessa review complete"
    );

    await collections.reviews.updateOne(
      { _id: params.reviewId },
      { $set: { status: "success", summary: result.summary, comments, finishedAt: new Date() } }
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
          errorMessage: error instanceof Error ? error.message : String(error),
          finishedAt: new Date(),
        },
      }
    );
  }
}
