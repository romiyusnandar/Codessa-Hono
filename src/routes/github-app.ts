import { Hono } from "hono";
import { sign, verify } from "hono/jwt";
import { ObjectId } from "mongodb";
import { collections } from "../db/client.js";
import { getInstallationForAccount } from "../services/github-app.service.js";
import { requireAuth, type AuthVariables } from "../middleware/require-auth.js";

const appSlug = process.env.GITHUB_APP_SLUG ?? "";
const jwtSecret = process.env.JWT_SECRET ?? "";

export const githubAppRoute = new Hono<{ Variables: AuthVariables }>();

githubAppRoute.get("/install", requireAuth, async (c) => {
  const userId = c.get("userId");
  const state = await sign({ userId, exp: Math.floor(Date.now() / 1000) + 600 }, jwtSecret);

  return c.redirect(`https://github.com/apps/${appSlug}/installations/new?state=${state}`);
});

githubAppRoute.get("/callback", async (c) => {
  const installationId = c.req.query("installation_id");
  const setupAction = c.req.query("setup_action");
  const state = c.req.query("state");

  if (!installationId || !state || setupAction === "request") {
    return c.json({ error: "Invalid or pending installation request" }, 400);
  }

  let userId: string;
  try {
    const payload = await verify(state, jwtSecret, "HS256");
    userId = payload.userId as string;
  } catch {
    return c.json({ error: "Invalid or expired state" }, 400);
  }

  const account = await getInstallationForAccount(Number(installationId));
  const accountLogin = "login" in account.account! ? account.account.login : account.account!.slug;

  await collections.installations.updateOne(
    { installationId: Number(installationId) },
    {
      $set: {
        installationId: Number(installationId),
        accountLogin: accountLogin ?? "unknown",
        accountType: account.target_type as "User" | "Organization",
        userId: new ObjectId(userId),
      },
      $unset: { suspendedAt: "" },
      $setOnInsert: { createdAt: new Date() },
    },
    { upsert: true }
  );

  return c.json({ ok: true, installationId: Number(installationId) });
});
