import * as Cloudflare from "alchemy/Cloudflare";

/**
 * A D1 database that stores connected-account ids after onboarding.
 * Files under `./migrations` are sorted by numeric prefix and applied in
 * order on every deploy; already-applied migrations are skipped.
 */
export const Database = Cloudflare.D1.Database("Database", {
  migrations: "./migrations",
});
