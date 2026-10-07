CREATE TABLE `categories` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`color` text NOT NULL,
	`icon` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text,
	CONSTRAINT "categories_kind_ck" CHECK("categories"."kind" in ('income', 'expense'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `categories_kind_name_active_uq` ON `categories` (`kind`,lower("name")) WHERE "categories"."deleted_at" is null;--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `transactions` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`currency` text NOT NULL,
	`category_id` text NOT NULL,
	`date` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "transactions_kind_ck" CHECK("transactions"."kind" in ('income', 'expense')),
	CONSTRAINT "transactions_amount_ck" CHECK("transactions"."amount_minor" > 0 and "transactions"."amount_minor" <= 10000000000000)
);
--> statement-breakpoint
CREATE INDEX `transactions_date_idx` ON `transactions` (`date`);--> statement-breakpoint
CREATE INDEX `transactions_category_idx` ON `transactions` (`category_id`);--> statement-breakpoint
CREATE INDEX `transactions_kind_date_idx` ON `transactions` (`kind`,`date`);--> statement-breakpoint
CREATE INDEX `transactions_deleted_idx` ON `transactions` (`deleted_at`);