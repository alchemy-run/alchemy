import * as Cloudflare from "alchemy/Cloudflare";

/** The D1 database the Ledger projection writes, outside the domain model. */
export const LedgerDatabase = Cloudflare.D1.Database("LedgerDatabase", {
  migrations: "./migrations/ledger",
});
