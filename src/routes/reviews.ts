import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { reviews, reviewComments, repositories } from "../db/schema.js";

export const reviewsRoute = new Hono();

reviewsRoute.get("/", async (c) => {
  const repoFullName = c.req.query("repo");

  const rows = repoFullName
    ? await db
        .select()
        .from(reviews)
        .innerJoin(repositories, eq(reviews.repositoryId, repositories.id))
        .where(eq(repositories.fullName, repoFullName))
    : await db.select().from(reviews);

  return c.json(rows);
});

reviewsRoute.get("/:id", async (c) => {
  const id = Number(c.req.param("id"));

  const review = await db.query.reviews.findFirst({ where: eq(reviews.id, id) });
  if (!review) {
    return c.json({ error: "Not found" }, 404);
  }

  const comments = await db.select().from(reviewComments).where(eq(reviewComments.reviewId, id));

  return c.json({ ...review, comments });
});
