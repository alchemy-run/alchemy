import { DeployVersion } from "@alchemy.run/cloudflare/Domain/Version";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { After, benchWorker, hosted } from "../bench/worker.ts";
import { Deposits } from "../catch-up/ledger.ts";

/**
 * The bench model (accounts, and every deposit to each, in the order its
 * view applied them), laid out as Domain version `layout` lays it out:
 * version 0 (a class per definition) or 1 (one shared class). `version` is
 * what `GET /version` answers.
 */
export const moveWorker = (version: string, layout: 0 | 1) =>
  benchWorker(version, { kind: "deposits", view: Deposits }).pipe(
    Effect.provide(hosted(After.layer(Layer.empty))),
    Effect.provideService(DeployVersion, layout),
  );
