import { App } from "octokit";

let app: App | undefined;

function getApp(): App {
  if (!app) {
    app = new App({
      appId: process.env.GITHUB_APP_ID ?? "",
      privateKey: (process.env.GITHUB_APP_PRIVATE_KEY ?? "").replace(/\\n/g, "\n"),
      webhooks: { secret: process.env.GITHUB_WEBHOOK_SECRET ?? "" },
    });
  }
  return app;
}

export type InstallationRepo = {
  githubRepoId: string;
  fullName: string;
  owner: string;
  name: string;
  private: boolean;
  defaultBranch: string;
};

export async function getInstallationOctokit(installationId: number) {
  return getApp().getInstallationOctokit(installationId);
}

export async function listInstallationRepos(installationId: number): Promise<InstallationRepo[]> {
  const octokit = await getInstallationOctokit(installationId);
  const repos = await octokit.paginate(octokit.rest.apps.listReposAccessibleToInstallation, { per_page: 100 });

  return repos.map((repo) => ({
    githubRepoId: String(repo.id),
    fullName: repo.full_name,
    owner: repo.owner.login,
    name: repo.name,
    private: repo.private,
    defaultBranch: repo.default_branch ?? "main",
  }));
}

export async function getInstallationForAccount(installationId: number) {
  const { data } = await getApp().octokit.rest.apps.getInstallation({ installation_id: installationId });
  return data;
}
