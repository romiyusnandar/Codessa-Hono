import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  githubId: text("github_id").notNull().unique(),
  username: text("username").notNull(),
  accessToken: text("access_token"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

export const repositories = sqliteTable("repositories", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").notNull().references(() => users.id),
  githubRepoId: text("github_repo_id").notNull().unique(),
  fullName: text("full_name").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  excludePaths: text("exclude_paths"),
  customInstructions: text("custom_instructions"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

export const reviews = sqliteTable("reviews", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  repositoryId: integer("repository_id").notNull().references(() => repositories.id),
  pullNumber: integer("pull_number").notNull(),
  commitSha: text("commit_sha").notNull(),
  status: text("status", { enum: ["pending", "running", "success", "failed", "skipped"] })
    .notNull()
    .default("pending"),
  summary: text("summary"),
  rawResponse: text("raw_response"),
  promptTokens: integer("prompt_tokens"),
  completionTokens: integer("completion_tokens"),
  errorMessage: text("error_message"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  finishedAt: integer("finished_at", { mode: "timestamp" }),
});

export const reviewComments = sqliteTable("review_comments", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  reviewId: integer("review_id").notNull().references(() => reviews.id),
  filePath: text("file_path").notNull(),
  line: integer("line"),
  severity: text("severity", { enum: ["info", "minor", "major", "critical"] }).notNull(),
  comment: text("comment").notNull(),
});
