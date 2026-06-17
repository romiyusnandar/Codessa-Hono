import type { ObjectId } from "mongodb";

export type User = {
  _id?: ObjectId;
  githubId: string;
  username: string;
  accessToken?: string;
  createdAt: Date;
};

export type Repository = {
  _id?: ObjectId;
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
  status: "pending" | "running" | "success" | "failed" | "skipped";
  summary?: string;
  comments: ReviewComment[];
  promptTokens?: number;
  completionTokens?: number;
  errorMessage?: string;
  createdAt: Date;
  finishedAt?: Date;
};
