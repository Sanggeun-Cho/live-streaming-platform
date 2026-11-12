ALTER TABLE `comments` ADD `donation_id` integer REFERENCES donations(id);--> statement-breakpoint
CREATE UNIQUE INDEX `comments_donation_id_unique` ON `comments` (`donation_id`);