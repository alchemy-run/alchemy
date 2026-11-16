/**
 * Classes on Cloud Run pools, only ever planned: one whose pool reads a
 * secret with the worker pool's own account, and one whose pool joins the
 * control plane's GCP network. The test provides the cluster.
 */
import * as Rivet from "@alchemy.run/rivet";
import * as RivetGCP from "@alchemy.run/rivet/GCP";
import * as Effect from "effect/Effect";

const ping = Effect.succeed(Effect.succeed({ ping: () => Effect.succeed("pong") }));

export class Secretive extends Rivet.DurableObject<Secretive>()(
  "Secretive",
  { main: import.meta.url, handler: "Secretive" },
  ping.pipe(
    Effect.provide(
      RivetGCP.CloudRunPool("Secrets", {
        location: "us-central1",
        secrets: { DATABASE_URL: "projects/acme/secrets/db/versions/3" },
      }),
    ),
  ),
) {}

export class Private extends Rivet.DurableObject<Private>()(
  "Private",
  { main: import.meta.url, handler: "Private" },
  ping.pipe(Effect.provide(RivetGCP.CloudRunPool("Joined", { clusterNetwork: true }))),
) {}
