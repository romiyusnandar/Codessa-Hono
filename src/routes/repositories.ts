import { Hono } from "hono";
import { ObjectId } from "mongodb";
import { collections } from "../db/client.js";
import { requireAuth, type AuthVariables } from "../middleware/require-auth.js";
import { listInstallationRepos } from "../services/github-app.service.js";

export const repositoriesRoute = new Hono<{ Variables: AuthVariables }>();

repositoriesRoute.use("*", requireAuth);

repositoriesRoute.get("/", async (c) => {
  const userId = new ObjectId(c.get("userId"));

  const page = Math.max(1, Number(c.req.query("page") ?? 1));
  const perPage = Math.min(100, Math.max(1, Number(c.req.query("perPage") ?? 20)));
  const search = c.req.query("search")?.trim().toLowerCase();

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
    .map((repo) => ({
      ...repo,
      enabled: enabledByFullName.get(repo.fullName)?.enabled ?? false,
    }));

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
