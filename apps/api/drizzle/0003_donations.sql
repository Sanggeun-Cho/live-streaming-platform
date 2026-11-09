CREATE TABLE `donation_orders` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`order_id` text NOT NULL,
	`broadcast_id` integer NOT NULL,
	`donor_id` integer NOT NULL,
	`amount` integer NOT NULL,
	`message` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'PENDING' NOT NULL,
	`payment_key` text,
	`failure_code` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`broadcast_id`) REFERENCES `broadcasts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`donor_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `donation_orders_order_id_unique` ON `donation_orders` (`order_id`);--> statement-breakpoint
CREATE INDEX `donation_orders_broadcast_id_idx` ON `donation_orders` (`broadcast_id`);--> statement-breakpoint
CREATE TABLE `donations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`order_id` integer NOT NULL,
	`broadcast_id` integer NOT NULL,
	`donor_id` integer NOT NULL,
	`amount` integer NOT NULL,
	`message` text DEFAULT '' NOT NULL,
	`payment_key` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `donation_orders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`broadcast_id`) REFERENCES `broadcasts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`donor_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `donations_order_id_unique` ON `donations` (`order_id`);--> statement-breakpoint
CREATE INDEX `donations_broadcast_id_id_idx` ON `donations` (`broadcast_id`,`id`);