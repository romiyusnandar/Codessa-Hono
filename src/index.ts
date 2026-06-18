import "dotenv/config";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { connectMongo } from "./db/client.js";
import { webhookRoute } from "./routes/webhook.js";
import { reviewsRoute } from "./routes/reviews.js";
import { authRoute } from "./routes/auth.js";
import { repositoriesRoute } from "./routes/repositories.js";
import { githubAppRoute } from "./routes/github-app.js";
import { docsRoute } from "./routes/docs.js";

const app = new Hono();

app.use(
  "*",
  cors({
    origin: (origin) => origin ?? "*",
    credentials: true,
  })
);

app.get("/", (c) => c.json({ name: "Codessa", status: "ok", docs: "/docs" }));
app.route("/webhooks", webhookRoute);
app.route("/auth", authRoute);
app.route("/github-app", githubAppRoute);
app.route("/repositories", repositoriesRoute);
app.route("/reviews", reviewsRoute);
app.route("/", docsRoute);

const port = Number(process.env.PORT ?? 3000);

await connectMongo();

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Codessa listening on http://localhost:${info.port}`);
});
