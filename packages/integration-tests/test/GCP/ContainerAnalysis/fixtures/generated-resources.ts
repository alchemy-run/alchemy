import * as GCP from "@alchemy.run/gcp";
import * as Effect from "effect/Effect";
import { TEST_ATTESTATION, TEST_RESOURCE_URI } from "../common.ts";

/** Resources the generated Container Analysis bindings bind. */
export { Authority, Signed } from "./bindings-host.ts";

export const RegionalNote = GCP.ContainerAnalysis.LocationsNote("ProbeRegionalNote", {
  location: "us-central1",
  shortDescription: "probe attestor",
  attestation: { hint: { humanReadableName: "Alchemy Probe" } },
});
export const RegionalOccurrence = Effect.gen(function* () {
  const note = yield* RegionalNote;
  return yield* GCP.ContainerAnalysis.LocationsOccurrence("ProbeRegionalOccurrence", {
    location: "us-central1",
    noteName: note.name,
    resourceUri: TEST_RESOURCE_URI,
    attestation: TEST_ATTESTATION,
  });
});
