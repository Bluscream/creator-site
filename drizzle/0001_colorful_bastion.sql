CREATE TABLE `connections` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`platform` text NOT NULL,
	`platform_account_id` text NOT NULL,
	`handle` text,
	`display_name` text,
	`avatar_url` text,
	`method` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`expires_at` integer,
	`scopes` text DEFAULT '' NOT NULL,
	`shown` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `connections_platform_account` ON `connections` (`platform`,`platform_account_id`);--> statement-breakpoint
CREATE INDEX `connections_user` ON `connections` (`user_id`);--> statement-breakpoint
CREATE INDEX `connections_platform` ON `connections` (`platform`);