import * as GCP from "@alchemy.run/gcp";
import { GcpEnvironment } from "@alchemy.run/gcp/Environment";
import * as Effect from "effect/Effect";

/** Observability resources the generated bindings bind. */

export const ProbeTraceScope = Effect.gen(function* () {
  const { project } = yield* GcpEnvironment.current;
  return yield* GCP.Observability.TraceScope("ProbeTraceScope", {
    resourceNames: [`projects/${project}`],
  });
});
