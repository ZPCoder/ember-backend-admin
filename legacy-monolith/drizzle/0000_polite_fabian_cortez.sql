CREATE TABLE `audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`player_id` text NOT NULL,
	`action` text NOT NULL,
	`idempotency_key` text,
	`payload_json` text NOT NULL,
	`result_json` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`player_id`) REFERENCES `players`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `audit_events_player_idempotency_uidx` ON `audit_events` (`player_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `audit_events_player_created_idx` ON `audit_events` (`player_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `match_records` (
	`id` text PRIMARY KEY NOT NULL,
	`player_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`result` text NOT NULL,
	`mode` text NOT NULL,
	`opponent` text NOT NULL,
	`reward_gold` integer NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`player_id`) REFERENCES `players`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `match_records_player_idempotency_uidx` ON `match_records` (`player_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `match_records_player_created_idx` ON `match_records` (`player_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `player_states` (
	`player_id` text PRIMARY KEY NOT NULL,
	`state_json` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`player_id`) REFERENCES `players`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `players` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`display_name` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `players_email_uidx` ON `players` (`email`);