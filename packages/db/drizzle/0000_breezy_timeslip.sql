CREATE TABLE `artifacts` (
	`id` text NOT NULL,
	`task_id` text NOT NULL,
	`order_idx` integer NOT NULL,
	`kind` text NOT NULL,
	`ref` text NOT NULL,
	`produced_by_step` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`task_id`, `id`),
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `artifacts_by_task` ON `artifacts` (`task_id`,`order_idx`);--> statement-breakpoint
CREATE TABLE `decision_log` (
	`task_id` text NOT NULL,
	`order_idx` integer NOT NULL,
	`type` text NOT NULL,
	`at` text NOT NULL,
	`goal` text,
	`step_id` text,
	`gate_id` text,
	`decision` text,
	`notes` text,
	`reason` text,
	PRIMARY KEY(`task_id`, `order_idx`),
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `gates` (
	`id` text NOT NULL,
	`task_id` text NOT NULL,
	`order_idx` integer NOT NULL,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`decided_at` text,
	`decision` text,
	`notes` text,
	PRIMARY KEY(`task_id`, `id`),
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `gates_by_task` ON `gates` (`task_id`,`order_idx`);--> statement-breakpoint
CREATE TABLE `steps` (
	`id` text NOT NULL,
	`task_id` text NOT NULL,
	`order_idx` integer NOT NULL,
	`capability` text NOT NULL,
	`description` text NOT NULL,
	`status` text NOT NULL,
	`acceptance_criteria` text NOT NULL,
	`artifact_ids` text NOT NULL,
	`gate_after` text,
	`started_at` text,
	`completed_at` text,
	`failure_reason` text,
	PRIMARY KEY(`task_id`, `id`),
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `steps_by_task` ON `steps` (`task_id`,`order_idx`);--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`goal` text NOT NULL,
	`repo_owner` text NOT NULL,
	`repo_name` text NOT NULL,
	`worktree_path` text,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
