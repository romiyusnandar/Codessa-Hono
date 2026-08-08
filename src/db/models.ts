import type { ObjectId } from "mongodb";

export type UserSettings = {
  reviewLanguage?: string;
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
  summary?: string;
  comments: ReviewComment[];
  promptTokens?: number;
  completionTokens?: number;
  errorMessage?: string;
  createdAt: Date;
  finishedAt?: Date;
};
