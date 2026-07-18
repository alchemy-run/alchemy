import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { Disk } from "./Disk.ts";
import { Grep } from "./Grep.ts";
import { makeGrepClient, makeHttpAuth } from "./RuntimeAuth.ts";

/**
 * HTTP-backed implementation of the {@link Grep} binding.
 *
 * Mints a dedicated `Archil.ApiToken` for the host Function/Worker and binds
 * its value as a secret. Works on any Alchemy host.
 */
export const GrepHttp = Layer.effect(
  Grep,
  Effect.gen(function* () {
    const auth = yield* makeHttpAuth;
    return Effect.fn(function* (disk: Disk) {
      const a = yield* auth;
      const diskId = yield* disk.diskId;
      const region = yield* disk.region;
      return makeGrepClient(a, diskId, region);
    });
  }),
);
