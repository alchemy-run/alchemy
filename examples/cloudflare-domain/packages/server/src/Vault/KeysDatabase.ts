import * as Cloudflare from "@alchemy.run/cloudflare";

/**
 * The D1 database that holds one key per customer, apart from the model's
 * own storage: deleting a row is what makes a customer's sealed data unreadable.
 */
export const KeysDatabase = Cloudflare.D1.Database("KeysDatabase", {
  migrations: "packages/server/migrations/vault",
});
