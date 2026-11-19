// Deep imports keep the Compute bundle lean (see bucket.ts).
import { Compute } from "@alchemy.run/prisma/Compute";
import { Project } from "@alchemy.run/prisma/Project";
import * as Effect from "effect/Effect";
import { CollectorTelemetry, tracedFetch } from "../../Utils/Telemetry.ts";

export const TracedProject = Project("PrismaTracedProject", { createDatabase: false });

/** A Compute app that exports one span per `/work` request over OTLP. */
export default Compute(
  "PrismaTracedCompute",
  Effect.gen(function* () {
    return {
      project: yield* TracedProject,
      main: import.meta.filename,
      port: 8080,
      timeoutSeconds: 240,
      destroyOldDeployment: true,
    };
  }),
  Effect.succeed({ fetch: tracedFetch }).pipe(
    Effect.provide(CollectorTelemetry("prisma-compute-e2e")),
  ),
);
