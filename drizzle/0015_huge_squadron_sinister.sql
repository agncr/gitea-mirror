DROP INDEX `uniq_organizations_user_normalized_name`;--> statement-breakpoint
ALTER TABLE `organizations` ADD `provider` text DEFAULT 'github' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_organizations_user_provider_normalized_name` ON `organizations` (`user_id`,`provider`,`normalized_name`);--> statement-breakpoint
DROP INDEX `uniq_repositories_user_full_name`;--> statement-breakpoint
DROP INDEX `uniq_repositories_user_normalized_full_name`;--> statement-breakpoint
ALTER TABLE `repositories` ADD `provider` text DEFAULT 'github' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_repositories_user_provider_full_name` ON `repositories` (`user_id`,`provider`,`full_name`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_repositories_user_provider_normalized_full_name` ON `repositories` (`user_id`,`provider`,`normalized_full_name`);--> statement-breakpoint
ALTER TABLE `configs` ADD `gitlab_config` text;