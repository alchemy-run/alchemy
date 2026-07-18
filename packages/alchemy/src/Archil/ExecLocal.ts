import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { Disk } from "./Disk.ts";
import { Exec } from "./Exec.ts";
import { makeExecClient, makeLocalAuth } from "./RuntimeAuth.ts";

/**
 * Current-credentials implementation of the {@link Exec} binding.
 *
 * Runs exec calls with the ambient deploy-time API key (profile /
 * `ARCHIL_API_KEY`) instead of minting a token — for scripts, Actions, and
 * tests. Registers no binding on any host.
 */
export const ExecLocal = Layer.effect(
  Exec,
  Effect.gen(function* () {
    const auth = yield* makeLocalAuth;
    return Effect.fn(function* (disk: Disk) {
      const a = yield* auth;
      const diskId = yield* disk.diskId;
      const region = yield* disk.region;
      return makeExecClient(a, diskId, region);
    });
  }),
);
