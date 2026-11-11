import * as GCP from "@alchemy.run/gcp";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { missingName } from "../../lookup.ts";
import { expectAllMissing } from "../lookup.ts";

const { test } = Test.make({ providers: GCP.providers() });

const tags = ["provider:gcp", "provider:gcp:saasservicemanagement", "live"];

// A lookup of a resource that doesn't exist fails the deploy with
// LookupNotFoundError.
test.provider(
  "a lookup of a missing resource fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectAllMissing(stack, {
        "missing-release": GCP.SaasServiceManagement.Release.lookup({ releaseId: name }).name,
        "missing-rollout": GCP.SaasServiceManagement.Rollout.lookup({ rolloutId: name }).name,
        "missing-rollout-kind": GCP.SaasServiceManagement.RolloutKind.lookup({
          rolloutKindId: name,
        }).name,
        "missing-saa": GCP.SaasServiceManagement.Saa.lookup({ saasId: name }).name,
        "missing-tenant": GCP.SaasServiceManagement.Tenant.lookup({ tenantId: name }).name,
        "missing-unit": GCP.SaasServiceManagement.Unit.lookup({ unitId: name }).name,
        "missing-unit-kind": GCP.SaasServiceManagement.UnitKind.lookup({ unitKindId: name }).name,
        "missing-unit-operation": GCP.SaasServiceManagement.UnitOperation.lookup({
          unitOperationId: name,
        }).name,
      });
    }),
  { tags, timeout: 180000 },
);
