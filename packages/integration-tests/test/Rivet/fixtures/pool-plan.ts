/**
 * Classes on a local pool, only ever planned: one that sets its RivetKit
 * actor options and one that doesn't. The test provides the cluster.
 */
import * as Rivet from "@alchemy.run/rivet";
import * as RivetDocker from "@alchemy.run/rivet/Docker";
import * as Effect from "effect/Effect";

const ping = Effect.succeed(Effect.succeed({ ping: () => Effect.succeed("pong") }));

export class Tuned extends Rivet.DurableObject<Tuned>()(
  "Tuned",
  {
    main: import.meta.url,
    handler: "Tuned",
    actorOptions: { sleepTimeout: 60_000, sleepGracePeriod: 30_000 },
  },
  ping.pipe(Effect.provide(RivetDocker.SwarmPool("Default"))),
) {}

export class Plain extends Rivet.DurableObject<Plain>()(
  "Plain",
  { main: import.meta.url, handler: "Plain" },
  ping.pipe(Effect.provide(RivetDocker.SwarmPool("Default"))),
) {}
