ALTER TABLE `users` ADD `mailbox_policy` text;--> statement-breakpoint
ALTER TABLE `users` ADD `mailbox_policy_revision` integer DEFAULT 0 NOT NULL;