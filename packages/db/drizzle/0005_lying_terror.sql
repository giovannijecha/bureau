CREATE TABLE `usage_events` (
	`id` text PRIMARY KEY NOT NULL,
	`day` text NOT NULL,
	`scope` text NOT NULL,
	`task_id` text,
	`model` text NOT NULL,
	`input_tokens` integer NOT NULL,
	`output_tokens` integer NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `usage_by_day` ON `usage_events` (`day`);