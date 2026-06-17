import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { db } from "../db/client.js";
import { repositories, reviews, reviewComments } from "../db/schema.js";
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

  const repository = await db.query.repositories.findFirst({
    where: and(eq(repositories.fullName, fullName), eq(repositories.enabled, true)),
  });

  if (!repository) {
    return c.json({ skipped: true, reason: "repository not enabled" });
  }

  const existing = await db.query.reviews.findFirst({
    where: and(eq(reviews.repositoryId, repository.id), eq(reviews.commitSha, commitSha)),
  });
  if (existing) {
    return c.json({ skipped: true, reason: "already reviewed this commit" });
  }

  const [review] = await db
    .insert(reviews)
    .values({
      repositoryId: repository.id,
      pullNumber,
      commitSha,
      status: "running",
      createdAt: new Date(),
    })
    .returning();

  c.executionCtx?.waitUntil?.(
    runReview({ owner, repo, pullNumber, commitSha, repositoryId: repository.id, reviewId: review.id, customInstructions: repository.customInstructions })
  );

  return c.json({ accepted: true, reviewId: review.id });
});

async function runReview(params: {
  owner: string;
  repo: string;
  pullNumber: number;
  commitSha: string;
  repositoryId: number;
  reviewId: number;
  customInstructions: string | null;
}) {
  const githubToken = process.env.GITHUB_TOKEN ?? "";
  const github = new GithubService(githubToken);
  const deepseek = new DeepseekService(deepseekApiKey);

  try {
    await github.setCommitStatus(params.owner, params.repo, params.commitSha, "pending", "Codessa is reviewing this PR");

    const files = await github.getPullRequestFiles(params.owner, params.repo, params.pullNumber);
    const result = await deepseek.reviewFiles(files, params.customInstructions ?? undefined);

    await db.insert(reviewComments).values(
      result.comments.map((comment) => ({
        reviewId: params.reviewId,
        filePath: comment.file,
        line: comment.line,
        severity: comment.severity,
        comment: comment.comment,
      }))
    );

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

    await db
      .update(reviews)
      .set({ status: "success", summary: result.summary, finishedAt: new Date() })
      .where(eq(reviews.id, params.reviewId));
  } catch (error) {
    await github.setCommitStatus(params.owner, params.repo, params.commitSha, "error", "Codessa review failed");
    await db
      .update(reviews)
      .set({
        status: "failed",
        errorMessage: error instanceof Error ? error.message : String(error),
        finishedAt: new Date(),
      })
      .where(eq(reviews.id, params.reviewId));
  }
}
