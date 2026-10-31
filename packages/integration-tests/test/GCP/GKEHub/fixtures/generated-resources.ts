import * as GCP from "@alchemy.run/gcp";
import * as Effect from "effect/Effect";
import { fleetMembership } from "./fleet.ts";

/** A Config Sync feature on the suite's own fleet membership. */
export const ProbeFeature = Effect.gen(function* () {
  const membership = yield* fleetMembership({});
  return yield* GCP.GKEHub.MembershipsFeature("ProbeFeature", {
    membership: membership.name,
    featureId: "configmanagement",
    spec: { configmanagement: { configSync: { enabled: false } } },
  });
});
