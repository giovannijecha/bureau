CREATE TABLE `notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`task_id` text,
	`subject` text NOT NULL,
	`body` text NOT NULL,
	`created_at` text NOT NULL,
	`read_at` text
);
--> statement-breakpoint
CREATE INDEX `notifications_by_created` ON `notifications` (`created_at`);