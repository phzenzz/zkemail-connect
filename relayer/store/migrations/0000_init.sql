CREATE TABLE `batches` (
	`address` text PRIMARY KEY NOT NULL,
	`root` text NOT NULL,
	`emails` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `notified` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`escrow_addr` text,
	`batch_addr` text,
	`leaf_index` integer,
	`recipient` text NOT NULL,
	`notified_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notified_escrow_uq` ON `notified` (`escrow_addr`);--> statement-breakpoint
CREATE UNIQUE INDEX `notified_batch_leaf_uq` ON `notified` (`batch_addr`,`leaf_index`);