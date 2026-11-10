CREATE TABLE `recordings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`broadcast_id` integer NOT NULL,
	`file_path` text NOT NULL,
	`started_at` integer NOT NULL,
	`duration_ms` integer NOT NULL,
	`size_bytes` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`broadcast_id`) REFERENCES `broadcasts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `recordings_file_path_unique` ON `recordings` (`file_path`);--> statement-breakpoint
CREATE INDEX `recordings_broadcast_started_idx` ON `recordings` (`broadcast_id`,`started_at`);