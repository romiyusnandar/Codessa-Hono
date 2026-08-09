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
  /** Which layer produced this finding: "ai" (DeepSeek review) or "sca" (OSV.dev dependency scan). */
  source?: "ai" | "sca";
  /** Set only for AI-flagged security vulnerabilities (layer 2: CWE classification). */
  cwe?: { id: string; name: string } | null;
  /**
   * CVSS v3.1 base score, computed server-side from a vector via the official FIRST
   * formula — never trusted from the AI or from OSV directly. Present for both AI
   * security findings (layer 2) and SCA findings (layer 1) when a vector was available.
   */
  cvss?: { vector: string; score: number } | null;
  /** OSV/CVE identifier, set only for SCA findings (layer 1). */
  vulnerabilityId?: string | null;
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
