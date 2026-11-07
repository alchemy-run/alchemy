import * as GCP from "@alchemy.run/gcp";
import * as Effect from "effect/Effect";
import { deployProject } from "../../deployProject.ts";

/** Observability resources the generated bindings bind. */

export const ProbeTraceScope = Effect.gen(function* () {
  const project = yield* deployProject;
  return yield* GCP.Observability.TraceScope("ProbeTraceScope", {
    resourceNames: [`projects/${project}`],
  });
});
