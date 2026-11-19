CREATE TABLE IF NOT EXISTS `db_migrations` (
	`plugin` text NOT NULL,
	`version` integer NOT NULL,
	`hash` text NOT NULL,
	`applied_at` integer NOT NULL,
	PRIMARY KEY(`plugin`, `version`)
);
