import * as DigitalOcean from "@alchemy.run/digitalocean";
import * as Effect from "effect/Effect";

/** The team's Container Registry; App Platform pulls the API's image from it. */
export const Registry = DigitalOcean.Registry("Registry", { tier: "starter" });

/** Uploads the API stores and serves. */
export const Uploads = DigitalOcean.Spaces.Bucket("Uploads", {
  region: "nyc3",
  forceDestroy: true,
});

/** A small PostgreSQL cluster. */
export const Db = DigitalOcean.Databases.Cluster("Db", {
  engine: "pg",
  size: "db-s-1vcpu-1gb",
  region: "nyc3",
});

/**
 * The App's database in the cluster. Migrations run on every deploy, before
 * the API's new version.
 */
export const AppDb = Effect.gen(function* () {
  const db = yield* Db;
  return yield* DigitalOcean.Databases.Database("App", {
    clusterId: db.clusterId,
    migrations: "./migrations",
  });
});
