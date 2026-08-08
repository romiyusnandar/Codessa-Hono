import type { ObjectId } from "mongodb";
import type { ReviewTone, SeverityThreshold, ReviewAnalysisFocus } from "../constants/review-config.js";

export type UserSettings = {
  reviewLanguage?: string;
  tone?: ReviewTone;
  customInstructions?: string;
};

export type User = {
  _id?: ObjectId;
  githubId: string;
  username: string;
  avatarUrl?: string;
  accessToken?: string;
  tokenRevokedAt?: Date;
  settings?: UserSettings;
  createdAt: Date;
};

export type Installation = {
  _id?: ObjectId;
  installationId: number;
  accountLogin: string;
  accountType: "User" | "Organization";
  userId: ObjectId;
  suspendedAt?: Date;
  createdAt: Date;
};

export type Repository = {
  _id?: ObjectId;
  installationId: number;
  userId: ObjectId;
  githubRepoId: string;
  fullName: string;
  enabled: boolean;
  excludePaths?: string[];
  customInstructions?: string;
  tone?: ReviewTone;
  severityThreshold?: SeverityThreshold;
  analysisFocus?: ReviewAnalysisFocus;
  createdAt: Date;
};

export type ReviewComment = {
  filePath: string;
  line: number | null;
  severity: "info" | "minor" | "major" | "critical";
  comment: string;
};

export type Review = {
  _id?: ObjectId;
  repositoryId: ObjectId;
  pullNumber: number;
  commitSha: string;
  commitMessage?: string;
  additions?: number;
  deletions?: number;
  status: "pending" | "running" | "success" | "failed" | "skipped";
  /**
   * Independent of `status`: `status` reflects whether the review PROCESS completed
   * without errors, `verdict` reflects the OUTCOME the AI found in the code.
   * A review can be `status: "success"` and `verdict: "issues_found"` at the same time —
   * the review ran fine, it just found critical/major problems in the PR.
   */
  verdict?: "passed" | "issues_found" | "error";
  summary?: string;
  comments: ReviewComment[];
  promptTokens?: number;
  completionTokens?: number;
  errorMessage?: string;
  createdAt: Date;
  finishedAt?: Date;
};
