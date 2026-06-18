import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { sign } from "hono/jwt";
import { Octokit } from "octokit";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { collections } from "../db/client.js";
import { requireAuth, type AuthVariables } from "../middleware/require-auth.js";

const clientId = process.env.GITHUB_CLIENT_ID ?? "";
const clientSecret = process.env.GITHUB_CLIENT_SECRET ?? "";
const callbackUrl = process.env.GITHUB_CALLBACK_URL ?? "http://localhost:3000/auth/github/callback";
const jwtSecret = process.env.JWT_SECRET ?? "";
const isProd = process.env.NODE_ENV === "production";

export const authRoute = new Hono<{ Variables: AuthVariables }>();

authRoute.get("/github", (c) => {
  const state = randomBytes(16).toString("hex");

  setCookie(c, "oauth_state", state, {
    httpOnly: true,
    secure: isProd,
    sameSite: "Lax",
    maxAge: 600,
    path: "/",
  });

  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", callbackUrl);
  url.searchParams.set("scope", "repo user:email");
  url.searchParams.set("state", state);

  return c.redirect(url.toString());
});

authRoute.get("/github/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  const expectedState = getCookie(c, "oauth_state");

  deleteCookie(c, "oauth_state", { path: "/" });

  if (!code || !state || !expectedState || state !== expectedState) {
    return c.json({ error: "Invalid OAuth state" }, 400);
  }

  const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: callbackUrl,
    }),
  });

  const tokenData = (await tokenResponse.json()) as { access_token?: string; error?: string };
  if (!tokenData.access_token) {
    return c.json({ error: tokenData.error ?? "Failed to obtain access token" }, 400);
  }

  const octokit = new Octokit({ auth: tokenData.access_token });
  const { data: githubUser } = await octokit.rest.users.getAuthenticated();

  const result = await collections.users.findOneAndUpdate(
    { githubId: String(githubUser.id) },
    {
      $set: {
        githubId: String(githubUser.id),
        username: githubUser.login,
        avatarUrl: githubUser.avatar_url,
        accessToken: tokenData.access_token,
      },
      $unset: { tokenRevokedAt: "" },
      $setOnInsert: { createdAt: new Date() },
    },
    { upsert: true, returnDocument: "after" }
  );

  if (!result?._id) {
    return c.json({ error: "Failed to create user" }, 500);
  }

  const jwt = await sign(
    { sub: result._id.toString(), username: result.username, exp: Math.floor(Date.now() / 1000) + 7 * 24 * 3600 },
    jwtSecret
  );

  setCookie(c, "session", jwt, {
    httpOnly: true,
    secure: isProd,
    sameSite: "Lax",
    maxAge: 7 * 24 * 3600,
    path: "/",
  });

  return c.redirect("/auth/me");
});

authRoute.get("/me", requireAuth, async (c) => {
  const userId = c.get("userId");
  const user = await collections.users.findOne({ _id: new ObjectId(userId) });

  if (!user) {
    return c.json({ error: "Not found" }, 404);
  }

  return c.json({
    id: user._id,
    username: user.username,
    githubId: user.githubId,
    avatarUrl: user.avatarUrl,
    tokenRevoked: Boolean(user.tokenRevokedAt),
    settings: user.settings ?? {},
  });
});

authRoute.post("/logout", (c) => {
  deleteCookie(c, "session", { path: "/" });
  return c.json({ ok: true });
});

const updateSettingsSchema = z.object({
  reviewLanguage: z.string().min(2).max(50).optional(),
});

authRoute.patch("/settings", requireAuth, async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json().catch(() => null);
  const parsed = updateSettingsSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: "Invalid settings payload" }, 400);
  }

  const result = await collections.users.findOneAndUpdate(
    { _id: new ObjectId(userId) },
    { $set: Object.fromEntries(Object.entries(parsed.data).map(([key, value]) => [`settings.${key}`, value])) },
    { returnDocument: "after" }
  );

  if (!result) {
    return c.json({ error: "Not found" }, 404);
  }

  return c.json({ settings: result.settings ?? {} });
});
