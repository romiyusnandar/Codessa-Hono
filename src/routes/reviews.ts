import { Hono } from "hono";
import { ObjectId } from "mongodb";
import { collections } from "../db/client.js";

export const reviewsRoute = new Hono();

reviewsRoute.get("/", async (c) => {
  const repoFullName = c.req.query("repo");

  if (repoFullName) {
    const repository = await collections.repositories.findOne({ fullName: repoFullName });
    if (!repository) {
      return c.json([]);
    }
    const rows = await collections.reviews.find({ repositoryId: repository._id }).sort({ createdAt: -1 }).toArray();
    return c.json(rows);
  }

  const rows = await collections.reviews.find().sort({ createdAt: -1 }).toArray();
  return c.json(rows);
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

  return c.json(review);
});
