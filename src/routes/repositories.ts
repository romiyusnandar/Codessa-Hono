import { Hono } from "hono";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { collections } from "../db/client.js";
import { requireAuth, type AuthVariables } from "../middleware/require-auth.js";
import { listInstallationRepos } from "../services/github-app.service.js";
import { REVIEW_TONES, SEVERITY_THRESHOLDS } from "../constants/review-config.js";

export const repositoriesRoute = new Hono<{ Variables: AuthVariables }>();

repositoriesRoute.use("*", requireAuth);

const repoConfigSchema = z.object({
  customInstructions: z.string().max(4000).optional(),
  tone: z.enum(REVIEW_TONES).optional(),
  severityThreshold: z.enum(SEVERITY_THRESHOLDS).optional(),
  analysisFocus: z
    .object({
      security: z.boolean().optional(),
      performance: z.boolean().optional(),
      bugs: z.boolean().optional(),
      codeStyle: z.boolean().optional(),
    })
    .optional(),
});

repositoriesRoute.get("/", async (c) => {
  const userId = new ObjectId(c.get("userId"));

  const page = Math.max(1, Number(c.req.query("page") ?? 1));
  const perPage = Math.min(100, Math.max(1, Number(c.req.query("perPage") ?? 20)));
  const search = c.req.query("search")?.trim().toLowerCase();
  const enabledFilter = c.req.query("enabled");

  const installations = await collections.installations.find({ userId, suspendedAt: { $exists: false } }).toArray();

  const [allRepos, enabledRepos] = await Promise.all([
    Promise.all(installations.map((inst) => listInstallationRepos(inst.installationId))).then((lists) =>
      lists.flatMap((repos, i) => repos.map((repo) => ({ ...repo, installationId: installations[i].installationId })))
    ),
    collections.repositories.find({ userId }).toArray(),
  ]);

  const enabledByFullName = new Map(enabledRepos.map((r) => [r.fullName, r]));

  const repos = allRepos
    .filter((repo) => !search || repo.fullName.toLowerCase().includes(search))
    .map((repo) => {
      const saved = enabledByFullName.get(repo.fullName);
      return {
        ...repo,
        enabled: saved?.enabled ?? false,
        hasCustomConfig: Boolean(saved?.customInstructions || saved?.tone || saved?.severityThreshold || saved?.analysisFocus),
      };
    })
    .filter((repo) => enabledFilter === undefined || repo.enabled === (enabledFilter === "true"))
    .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));

  const total = repos.length;
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const start = (page - 1) * perPage;
  const data = repos.slice(start, start + perPage);

  return c.json({ data, page, perPage, total, totalPages });
});

repositoriesRoute.post("/:owner/:repo/enable", async (c) => {
  const userId = new ObjectId(c.get("userId"));
  const { owner, repo } = c.req.param();
  const fullName = `${owner}/${repo}`;

  const installations = await collections.installations.find({ userId, suspendedAt: { $exists: false } }).toArray();

  let target: { githubRepoId: string; installationId: number } | undefined;
  for (const inst of installations) {
    const repos = await listInstallationRepos(inst.installationId);
    const match = repos.find((r) => r.fullName === fullName);
    if (match) {
      target = { githubRepoId: match.githubRepoId, installationId: inst.installationId };
      break;
    }
  }

  if (!target) {
    return c.json({ error: "Repository not found or Codessa app not installed on it" }, 404);
  }

  await collections.repositories.updateOne(
    { userId, fullName },
    {
      $set: {
        userId,
        installationId: target.installationId,
        githubRepoId: target.githubRepoId,
        fullName,
        enabled: true,
      },
      $setOnInsert: { createdAt: new Date() },
    },
    { upsert: true }
  );

  return c.json({ ok: true });
});

repositoriesRoute.post("/:owner/:repo/disable", async (c) => {
  const userId = new ObjectId(c.get("userId"));
  const { owner, repo } = c.req.param();
  const fullName = `${owner}/${repo}`;

  await collections.repositories.updateOne({ userId, fullName }, { $set: { enabled: false } });

  return c.json({ ok: true });
});

repositoriesRoute.get("/:owner/:repo/config", async (c) => {
  const userId = new ObjectId(c.get("userId"));
  const { owner, repo } = c.req.param();
  const fullName = `${owner}/${repo}`;

  const repository = await collections.repositories.findOne({ userId, fullName });
  if (!repository) {
    return c.json({ error: "Repository not enabled yet" }, 404);
  }

  return c.json({
    customInstructions: repository.customInstructions ?? null,
    tone: repository.tone ?? null,
    severityThreshold: repository.severityThreshold ?? null,
    analysisFocus: repository.analysisFocus ?? null,
  });
});

repositoriesRoute.patch("/:owner/:repo/config", async (c) => {
  const userId = new ObjectId(c.get("userId"));
  const { owner, repo } = c.req.param();
  const fullName = `${owner}/${repo}`;

  const body = await c.req.json().catch(() => null);
  const parsed = repoConfigSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid config payload" }, 400);
  }

  const result = await collections.repositories.findOneAndUpdate(
    { userId, fullName },
    { $set: parsed.data },
    { returnDocument: "after" }
  );

  if (!result) {
    return c.json({ error: "Repository not enabled yet" }, 404);
  }

  return c.json({
    customInstructions: result.customInstructions ?? null,
    tone: result.tone ?? null,
    severityThreshold: result.severityThreshold ?? null,
    analysisFocus: result.analysisFocus ?? null,
  });
});
