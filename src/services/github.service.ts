import type { Octokit } from "octokit";

export type PullRequestFile = {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
};

export class GithubService {
  constructor(private octokit: Octokit) {}

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
      additions: file.additions,
      deletions: file.deletions,
      patch: file.patch,
    }));
  }

  async getCommitMessage(owner: string, repo: string, sha: string): Promise<string> {
    const { data } = await this.octokit.rest.repos.getCommit({ owner, repo, ref: sha });
    return data.commit.message;
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
