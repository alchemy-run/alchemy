import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { MultiExec, type MultiExecMounts } from "./MultiExec.ts";
import {
  makeLocalAuth,
  makeMultiExecClient,
  resolveMounts,
} from "./RuntimeAuth.ts";

/**
 * Current-credentials implementation of the {@link MultiExec} binding — for
 * scripts, Actions, and tests. Registers no binding on any host.
 */
export const MultiExecLocal = Layer.effect(
  MultiExec,
  Effect.gen(function* () {
    const auth = yield* makeLocalAuth;
    return Effect.fn(function* (disks: MultiExecMounts) {
      const a = yield* auth;
      const { mounts, region } = yield* resolveMounts(disks);
      return makeMultiExecClient(a, region, mounts);
    });
  }),
);
