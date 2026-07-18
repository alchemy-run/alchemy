import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { MultiExec, type MultiExecMounts } from "./MultiExec.ts";
import {
  makeHttpAuth,
  makeMultiExecClient,
  resolveMounts,
} from "./RuntimeAuth.ts";

/**
 * HTTP-backed implementation of the {@link MultiExec} binding.
 *
 * Mints a dedicated `Archil.ApiToken` for the host Function/Worker and binds
 * its value as a secret. Works on any Alchemy host.
 */
export const MultiExecHttp = Layer.effect(
  MultiExec,
  Effect.gen(function* () {
    const auth = yield* makeHttpAuth;
    return Effect.fn(function* (disks: MultiExecMounts) {
      const a = yield* auth;
      const { mounts, region } = yield* resolveMounts(disks);
      return makeMultiExecClient(a, region, mounts);
    });
  }),
);
