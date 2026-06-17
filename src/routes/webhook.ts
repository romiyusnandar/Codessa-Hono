import { Hono } from "hono";
import { ObjectId } from "mongodb";
import { collections } from "../db/client.js";
import { verifyGithubSignature, type WebhookVariables } from "../middleware/verify-github-signature.js";
import { GithubService } from "../services/github.service.js";
import { DeepseekService } from "../services/deepseek.service.js";

const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET ?? "";
const deepseekApiKey = process.env.DEEPSEEK_API_KEY ?? "";

export const webhookRoute = new Hono<{ Variables: WebhookVariables }>();

webhookRoute.post("/github", verifyGithubSignature(webhookSecret), async (c) => {
  const event = c.req.header("x-github-event");
  const rawBody = c.get("rawBody");
  const payload = JSON.parse(rawBody);

  if (event !== "pull_request" || !["opened", "synchronize", "reopened"].includes(payload.action)) {
    return c.json({ skipped: true });
  }

  const fullName = payload.repository.full_name as string;
  const [owner, repo] = fullName.split("/");
  const pullNumber = payload.pull_request.number as number;
  const commitSha = payload.pull_request.head.sha as string;

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

  c.executionCtx?.waitUntil?.(
    runReview({
      owner,
      repo,
      pullNumber,
      commitSha,
      reviewId: insertedId,
      customInstructions: repository.customInstructions,
    })
  );

  return c.json({ accepted: true, reviewId: insertedId });
});

async function runReview(params: {
  owner: string;
  repo: string;
  pullNumber: number;
  commitSha: string;
  reviewId: ObjectId;
  customInstructions?: string;
}) {
  const githubToken = process.env.GITHUB_TOKEN ?? "";
  const github = new GithubService(githubToken);
  const deepseek = new DeepseekService(deepseekApiKey);

  try {
    await github.setCommitStatus(params.owner, params.repo, params.commitSha, "pending", "Codessa is reviewing this PR");

    const files = await github.getPullRequestFiles(params.owner, params.repo, params.pullNumber);
    const result = await deepseek.reviewFiles(files, params.customInstructions);

    const comments = result.comments.map((c) => ({
      filePath: c.file,
      line: c.line,
      severity: c.severity,
      comment: c.comment,
    }));

    const inlineComments = result.comments
      .filter((c) => c.line !== null)
      .map((c) => ({ path: c.file, line: c.line as number, body: `**[${c.severity}]** ${c.comment}` }));

    await github.postReviewComment(params.owner, params.repo, params.pullNumber, result.summary, inlineComments);

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
    await github.setCommitStatus(params.owner, params.repo, params.commitSha, "error", "Codessa review failed");
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
