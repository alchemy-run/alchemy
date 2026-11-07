import * as GCP from "@alchemy.run/gcp";
import * as Effect from "effect/Effect";

/** DataLineage resources the generated bindings bind, mirroring each resource suite's smallest shape. */

export const ProbeProcess = GCP.DataLineage.Process("ProbeProcess", {
  location: "us-central1",
  displayName: "etl a",
  origin: { sourceType: "CUSTOM", name: "alchemy" },
  attributes: { env: "test" },
});

export const ProbeRun = Effect.gen(function* () {
  const process = yield* ProbeProcess;
  return yield* GCP.DataLineage.ProcessesRun("ProbeRun", {
    process: process.name,
    startTime: "2024-01-01T00:00:00Z",
    state: "STARTED",
  });
});
export const ProbeLineageEvent = Effect.gen(function* () {
  const run = yield* ProbeRun;
  return yield* GCP.DataLineage.ProcessesRunsLineageEvent("ProbeLineageEvent", {
    run: run.name,
    startTime: "2024-01-01T00:00:00Z",
    endTime: "2024-01-01T00:05:00Z",
    links: [
      {
        source: { fullyQualifiedName: "custom:alchemy_probe.raw.orders" },
        target: { fullyQualifiedName: "custom:alchemy_probe.dw.orders" },
      },
    ],
  });
});
