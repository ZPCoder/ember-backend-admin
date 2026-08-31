ALTER TABLE `players` ADD `identity_key` text;--> statement-breakpoint
CREATE UNIQUE INDEX `players_identity_key_uidx` ON `players` (`identity_key`);