CREATE TABLE `repositories` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`github_repo_id` text NOT NULL,
	`full_name` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`exclude_paths` text,
	`custom_instructions` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `repositories_github_repo_id_unique` ON `repositories` (`github_repo_id`);--> statement-breakpoint
CREATE TABLE `review_comments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`review_id` integer NOT NULL,
	`file_path` text NOT NULL,
	`line` integer,
	`severity` text NOT NULL,
	`comment` text NOT NULL,
	FOREIGN KEY (`review_id`) REFERENCES `reviews`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `reviews` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`repository_id` integer NOT NULL,
	`pull_number` integer NOT NULL,
	`commit_sha` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`summary` text,
	`raw_response` text,
	`prompt_tokens` integer,
	`completion_tokens` integer,
	`error_message` text,
	`created_at` integer NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`github_id` text NOT NULL,
	`username` text NOT NULL,
	`access_token` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_github_id_unique` ON `users` (`github_id`);