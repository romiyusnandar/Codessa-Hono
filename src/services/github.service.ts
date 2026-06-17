import { Octokit } from "octokit";

export type PullRequestFile = {
  filename: string;
  status: string;
  patch?: string;
};

export class GithubService {
  private octokit: Octokit;

  constructor(accessToken: string) {
    this.octokit = new Octokit({ auth: accessToken });
  }

  async getPullRequestFiles(owner: string, repo: string, pullNumber: number): Promise<PullRequestFile[]> {
    const files = await this.octokit.paginate(this.octokit.rest.pulls.listFiles, {
      owner,
      repo,
      pull_number: pullNumber,
      per_page: 100,
    });

    return files.map((file) => ({
      filename: file.filename,
      status: file.status,
      patch: file.patch,
    }));
  }

  async postReviewComment(
    owner: string,
    repo: string,
    pullNumber: number,
    body: string,
    comments: { path: string; line: number; body: string }[]
  ) {
    return this.octokit.rest.pulls.createReview({
      owner,
      repo,
      pull_number: pullNumber,
      event: "COMMENT",
      body,
      comments,
    });
  }

  async setCommitStatus(
    owner: string,
    repo: string,
    sha: string,
    state: "pending" | "success" | "failure" | "error",
    description: string
  ) {
    return this.octokit.rest.repos.createCommitStatus({
      owner,
      repo,
      sha,
      state,
      description,
      context: "codessa/ai-review",
    });
  }
}
