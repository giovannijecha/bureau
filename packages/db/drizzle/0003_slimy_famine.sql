CREATE TABLE `conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`project_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `messages` ADD `conversation_id` text;--> statement-breakpoint
CREATE INDEX `messages_by_conversation` ON `messages` (`conversation_id`,`seq`);