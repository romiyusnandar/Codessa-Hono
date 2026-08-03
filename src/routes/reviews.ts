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
