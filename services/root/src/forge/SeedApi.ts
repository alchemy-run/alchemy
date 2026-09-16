/**
 * The SEED door — mirror the org's repositories into the forge.
 *
 * - `POST /api/forge/seed` — kick every missing import (idempotent;
 *   an existing repo is reported, never re-imported)
 * - `GET  /api/forge/seed` — the seeds' statuses
 *   (`absent | importing | ready | failed`)
 *
 * The handlers build their own `Engine` per request over the SAME
 * Durable Objects and bucket the git routes use (namespaces and
 * bindings dedupe to the same underlying objects; the R2 binding is
 * registered at plan time by the GitServer stack).
 */
import {
  EngineLive,
  HasherInline,
  RegistryDurableObject,
  ReposDurableObject,
} from "alchemy/Git";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { GitBlobStore } from "./GitServer.ts";
import { seed, seedStatus } from "./Seed.ts";

/** The handlers' engine. NOTE the provide order: the blob store
 *  LAST, so it also feeds the hasher (which reads packs from it). */
const SeedEngine = EngineLive.pipe(
  Layer.provide(ReposDurableObject),
  Layer.provide(RegistryDurableObject),
  Layer.provide(HasherInline),
  Layer.provide(GitBlobStore),
);

export const SeedApi = Effect.gen(function* () {
  // built ONCE, in the worker init scope — that's where the bucket
  // and DO binding services live; handlers close over the context
  const engine = yield* Layer.build(SeedEngine);

  const kick = HttpRouter.add(
    "POST",
    "/api/forge/seed",
    Effect.gen(function* () {
      const reports = yield* seed.pipe(Effect.provide(engine), Effect.orDie);
      return yield* HttpServerResponse.json({ seeds: reports });
    }),
  );

  const status = HttpRouter.add(
    "GET",
    "/api/forge/seed",
    Effect.gen(function* () {
      const reports = yield* seedStatus.pipe(
        Effect.provide(engine),
        Effect.orDie,
      );
      return yield* HttpServerResponse.json({ seeds: reports });
    }),
  );

  return Layer.mergeAll(kick, status);
});
