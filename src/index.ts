import "dotenv/config";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { webhookRoute } from "./routes/webhook.js";
import { reviewsRoute } from "./routes/reviews.js";

const app = new Hono();

app.get("/", (c) => c.json({ name: "Codessa", status: "ok" }));
app.route("/webhooks", webhookRoute);
app.route("/reviews", reviewsRoute);

const port = Number(process.env.PORT ?? 3000);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Codessa listening on http://localhost:${info.port}`);
});
