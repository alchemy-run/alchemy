import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { Disk } from "./Disk.ts";
import { Grep } from "./Grep.ts";
import { makeGrepClient, makeLocalAuth } from "./RuntimeAuth.ts";

/**
 * Current-credentials implementation of the {@link Grep} binding — for
 * scripts, Actions, and tests. Registers no binding on any host.
 */
export const GrepLocal = Layer.effect(
  Grep,
  Effect.gen(function* () {
    const auth = yield* makeLocalAuth;
    return Effect.fn(function* (disk: Disk) {
      const a = yield* auth;
      const diskId = yield* disk.diskId;
      const region = yield* disk.region;
      return makeGrepClient(a, diskId, region);
    });
  }),
);
