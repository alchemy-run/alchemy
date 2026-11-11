import * as DigitalOcean from "@alchemy.run/digitalocean";

/** Uploads the API stores and serves. */
export const Uploads = DigitalOcean.Spaces.Bucket("Uploads", { region: "nyc3" });

/** A small PostgreSQL cluster. */
export const Db = DigitalOcean.Databases.Cluster("Db", {
  engine: "pg",
  size: "db-s-1vcpu-1gb",
  region: "nyc3",
});
