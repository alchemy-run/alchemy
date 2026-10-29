import * as GCP from "@alchemy.run/gcp";
import { GcpEnvironment } from "@alchemy.run/gcp/Environment";
import * as Effect from "effect/Effect";

/** Cloud Deploy resources the generated bindings bind. */
export const ProbeTarget = Effect.gen(function* () {
  const { project } = yield* GcpEnvironment.current;
  return yield* GCP.CloudDeploy.Target("ProbeTarget", {
    run: { location: `projects/${project}/locations/us-central1` },
  });
});
export const ProbePipeline = Effect.gen(function* () {
  const target = yield* ProbeTarget;
  return yield* GCP.CloudDeploy.DeliveryPipeline("ProbePipeline", {
    serialPipeline: { stages: [{ targetId: target.targetId }] },
  });
});
export const ProbePolicy = GCP.CloudDeploy.DeployPolicy("ProbePolicy", {
  selectors: [{ target: { id: "*" } }],
  rules: [
    {
      rolloutRestriction: {
        id: "weekends",
        timeWindows: {
          timeZone: "America/Los_Angeles",
          weeklyWindows: [{ daysOfWeek: ["SATURDAY", "SUNDAY"] }],
        },
      },
    },
  ],
});
export const ProbeCustomTargetType = GCP.CloudDeploy.CustomTargetType("ProbeCustomTargetType", {
  customActions: { deployAction: "helm-deploy" },
  description: "alchemy-test-custom-target",
});
