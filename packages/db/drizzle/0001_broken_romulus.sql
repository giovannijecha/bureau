CREATE TABLE `messages` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`task_id` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `messages_id_unique` ON `messages` (`id`);--> statement-breakpoint
CREATE INDEX `messages_by_seq` ON `messages` (`seq`);