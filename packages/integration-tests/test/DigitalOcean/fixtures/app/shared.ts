import * as DigitalOcean from "@alchemy.run/digitalocean";

/** The team's Container Registry; both fixture apps push to it. */
export const TestRegistry = DigitalOcean.Registry("Registry", {});
