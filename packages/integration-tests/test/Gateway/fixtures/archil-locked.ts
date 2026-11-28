import * as Archil from "@alchemy.run/archil";
import * as Effect from "effect/Effect";
import { app, WorkerGateway } from "../conformance/app.ts";

/**
 * The conformance program in an Archil sandbox that may reach nothing but
 * its gateway. Archil adds the gateway's token to requests to it, so the
 * sandbox holds no token either.
 */
export default class LockedArchil extends Archil.Sandbox<LockedArchil>()(
  "LockedArchil",
  {
    main: import.meta.url,
    port: 3000,
    idleTtlSeconds: 300,
    network: { egress: { default: "deny" } },
  },
  app.pipe(Effect.provide(WorkerGateway)),
) {}
