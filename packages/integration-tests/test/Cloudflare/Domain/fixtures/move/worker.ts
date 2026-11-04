import { DeployVersion } from "@alchemy.run/cloudflare/Domain/Version";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { AfterSummary, benchWorker, hosted, Summary } from "../bench/worker.ts";

/**
 * The bench model (accounts, and a summary per account), laid out as Domain
 * version `layout` lays it out: version 0 (a class per definition) or 1 (one
 * shared class). `version` is what `GET /version` answers.
 */
export const moveWorker = (version: string, layout: 0 | 1) =>
  benchWorker(version, { kind: "summary", view: Summary }).pipe(
    Effect.provide(hosted(AfterSummary.layer(Layer.empty))),
    Effect.provideService(DeployVersion, layout),
  );
