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
import { testReviewsRoute } from "./routes/test-reviews.js";
import { docsRoute } from "./routes/docs.js";
import { ALLOWED_ORIGINS } from "./constants/allowed-origins.js";

const app = new Hono();

// Explicit allowlist, not an origin-reflecting wildcard: with credentials:true, reflecting
// any origin back would let ANY website make cookie-authenticated requests on a logged-in
// user's behalf. Add every frontend that needs to call this API (main dashboard, test tools,
// etc.) to FRONTEND_URL / ADDITIONAL_ALLOWED_ORIGINS — comma-separated for the latter.
app.use(
  "*",
  cors({
    origin: (origin) => (origin && ALLOWED_ORIGINS.includes(origin) ? origin : undefined),
    credentials: true,
  })
);

app.get("/", (c) => c.json({ name: "Codessa", status: "ok", docs: "/docs" }));
app.route("/webhooks", webhookRoute);
app.route("/auth", authRoute);
app.route("/github-app", githubAppRoute);
app.route("/repositories", repositoriesRoute);
app.route("/reviews", reviewsRoute);
app.route("/test-reviews", testReviewsRoute);
app.route("/", docsRoute);

const port = Number(process.env.PORT ?? 3000);

await connectMongo();

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Codessa listening on http://localhost:${info.port}`);
});
