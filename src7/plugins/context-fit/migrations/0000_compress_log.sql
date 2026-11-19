CREATE TABLE IF NOT EXISTS `compress_log` (
	`session` text PRIMARY KEY NOT NULL,
	`upto` integer NOT NULL,
	`summary` text NOT NULL
);
