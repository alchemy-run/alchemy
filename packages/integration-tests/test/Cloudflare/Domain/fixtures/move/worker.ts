import { DeployVersion } from "@alchemy.run/cloudflare/Domain/Version";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { After, benchWorker, hosted } from "../bench/worker.ts";
import { Deposits } from "../catch-up/ledger.ts";

export interface MoveWorkerOptions {
  /** How long a deploy waits for the move (the Domain's `backfillTimeout`). */
  readonly timeout?: Duration.Input;
  /** A bug: once deployed, the Worker's code fails to start. */
  readonly broken?: boolean;
}

/**
 * The bench model (accounts, and every deposit to each, in the order its
 * view applied them), laid out as Domain version `layout` lays it out:
 * version 0 (a class per definition) or 1 (one shared class). `version` is
 * what `GET /version` answers.
 */
export const moveWorker = (version: string, layout: 0 | 1, options: MoveWorkerOptions = {}) =>
  Effect.gen(function* () {
    const worker = yield* benchWorker(version, { kind: "deposits", view: Deposits });
    if (options.broken && globalThis.__ALCHEMY_RUNTIME__)
      return yield* Effect.die(new Error("a bug in the Worker's code"));
    return worker;
  }).pipe(
    Effect.provide(
      hosted(
        After.layer(Layer.empty),
        options.timeout === undefined ? undefined : { backfillTimeout: options.timeout },
      ),
    ),
    Effect.provideService(DeployVersion, layout),
  );
