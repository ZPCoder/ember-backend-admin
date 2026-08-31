CREATE TABLE IF NOT EXISTS `pvp_match_participants` (
	`match_token` text PRIMARY KEY NOT NULL,
	`room_code` text NOT NULL,
	`host_identity` text NOT NULL,
	`guest_identity` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `pvp_match_participants_created_idx` ON `pvp_match_participants` (`created_at`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `pvp_matches` (
	`room_code` text PRIMARY KEY NOT NULL,
	`match_token` text NOT NULL,
	`state_json` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `pvp_matches_token_uidx` ON `pvp_matches` (`match_token`);
