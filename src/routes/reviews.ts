import { Hono } from "hono";
import { ObjectId } from "mongodb";
import { collections } from "../db/client.js";
import { requireAuth, type AuthVariables } from "../middleware/require-auth.js";

export const reviewsRoute = new Hono<{ Variables: AuthVariables }>();

reviewsRoute.use("*", requireAuth);

reviewsRoute.get("/", async (c) => {
  const userId = new ObjectId(c.get("userId"));
  const repoFullName = c.req.query("repo");

  const repoFilter = repoFullName ? { userId, fullName: repoFullName } : { userId };
  const ownedRepos = await collections.repositories.find(repoFilter).toArray();
  if (ownedRepos.length === 0) {
    return c.json([]);
  }

  const rows = await collections.reviews
    .find({ repositoryId: { $in: ownedRepos.map((r) => r._id as ObjectId) } })
    .sort({ createdAt: -1 })
    .toArray();

  const fullNameById = new Map(ownedRepos.map((r) => [r._id!.toString(), r.fullName]));
  const data = rows.map((row) => ({ ...row, repositoryFullName: fullNameById.get(row.repositoryId.toString()) }));

  return c.json(data);
});

reviewsRoute.get("/stats", async (c) => {
  const userId = new ObjectId(c.get("userId"));
  const repoFullName = c.req.query("repo");

  const repoFilter = repoFullName ? { userId, fullName: repoFullName } : { userId };
  const ownedRepos = await collections.repositories.find(repoFilter).toArray();

  const emptyStats = {
    totalPullRequests: 0,
    totalComments: 0,
    totalReviewTimeMs: 0,
    averageReviewTimeMs: 0,
  };

  if (ownedRepos.length === 0) {
    return c.json(emptyStats);
  }

  const repoIds = ownedRepos.map((r) => r._id as ObjectId);

  const [stats] = await collections.reviews
    .aggregate<{
      totalPullRequests: number;
      totalComments: number;
      totalReviewTimeMs: number;
      reviewsWithDuration: number;
    }>([
      { $match: { repositoryId: { $in: repoIds }, status: { $in: ["success", "failed"] } } },
      {
        $group: {
          _id: null,
          totalPullRequests: { $sum: 1 },
          totalComments: { $sum: { $size: { $ifNull: ["$comments", []] } } },
          totalReviewTimeMs: {
            $sum: {
              $cond: [{ $ne: ["$finishedAt", null] }, { $subtract: ["$finishedAt", "$createdAt"] }, 0],
            },
          },
          reviewsWithDuration: { $sum: { $cond: [{ $ne: ["$finishedAt", null] }, 1, 0] } },
        },
      },
    ])
    .toArray();

  if (!stats) {
    return c.json(emptyStats);
  }

  return c.json({
    totalPullRequests: stats.totalPullRequests,
    totalComments: stats.totalComments,
    totalReviewTimeMs: stats.totalReviewTimeMs,
    averageReviewTimeMs: stats.reviewsWithDuration
      ? Math.round(stats.totalReviewTimeMs / stats.reviewsWithDuration)
      : 0,
  });
});

reviewsRoute.get("/:id", async (c) => {
  const id = c.req.param("id");
  if (!ObjectId.isValid(id)) {
    return c.json({ error: "Invalid id" }, 400);
  }

  const review = await collections.reviews.findOne({ _id: new ObjectId(id) });
  if (!review) {
    return c.json({ error: "Not found" }, 404);
  }

  const userId = new ObjectId(c.get("userId"));
  const repository = await collections.repositories.findOne({ _id: review.repositoryId, userId });
  if (!repository) {
    return c.json({ error: "Not found" }, 404);
  }

  return c.json({ ...review, repositoryFullName: repository.fullName });
});
