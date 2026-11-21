/**
 * The front of the Domain conformance suite on the Durable Object pool: a
 * Worker that runs the model's Api side and reaches its entities through
 * the pool's gateway.
 */
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import { app } from "../../../Domain/conformance/app.ts";
import { ConformanceDurableObjectsLive } from "./live.ts";

export default class DomainDurableObjectsFront extends Cloudflare.Worker<DomainDurableObjectsFront>()(
  "ClusterDomainDurableObjectsFront",
  { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
  Effect.gen(function* () {
    return { fetch: yield* app };
  }).pipe(Effect.provide(ConformanceDurableObjectsLive)),
) {}
