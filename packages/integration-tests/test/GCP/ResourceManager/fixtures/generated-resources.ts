import * as GCP from "@alchemy.run/gcp";
import * as Effect from "effect/Effect";

/** ResourceManager resources the generated bindings bind, mirroring each resource suite's smallest shape. */

export const ProbeLien = GCP.ResourceManager.Lien("ProbeLien", {
  reason: "production API key",
});
export const ProbeTagKey = GCP.ResourceManager.TagKey("ProbeTagKey", {
  description: "deployment environment",
});

export const ProbeTagValue = Effect.gen(function* () {
  const key = yield* ProbeTagKey;
  return yield* GCP.ResourceManager.TagValue("ProbeTagValue", { parent: key.name });
});
