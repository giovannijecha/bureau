CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`name` text NOT NULL,
	`url` text NOT NULL,
	`base_branch` text NOT NULL,
	`test_command` text,
	`created_at` text NOT NULL
);
