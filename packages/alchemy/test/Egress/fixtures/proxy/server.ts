/**
 * Runs the egress proxy in a process of its own, so a test can measure the
 * proxy's memory alone (the test process's RSS moves with whatever else the
 * runner is doing). `bun server.ts <routes json> <trust bundle path>` prints
 * `{"url":…}` once it listens, then serves until killed.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { makeLocalCa } from "@/Egress/LocalCa.ts";
import { serveEgressProxy, writeTrustBundle } from "@/Egress/Proxy.ts";
import { Routes } from "@/Egress/Route.ts";
import { PlatformServices } from "@/Util/PlatformServices.ts";

const program = Effect.gen(function* () {
  const [routesJson = "[]", bundle] = yield* Effect.sync(() => process.argv.slice(2));
  const initial = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Routes))(routesJson);
  const routes = yield* SubscriptionRef.make(initial);
  const ca = yield* makeLocalCa;
  const proxy = yield* serveEgressProxy({ port: 0, routes, ca });
  if (bundle) yield* writeTrustBundle(bundle, [ca.pem]);
  yield* Effect.sync(() => process.stdout.write(`${JSON.stringify({ url: proxy.url })}\n`));
  return yield* Effect.never;
}).pipe(Effect.scoped, Effect.provide(PlatformServices));

Effect.runFork(program);
