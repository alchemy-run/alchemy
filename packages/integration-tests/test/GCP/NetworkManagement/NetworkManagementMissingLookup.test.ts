import * as GCP from "@alchemy.run/gcp";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { missingName } from "../../lookup.ts";
import { expectAllMissing } from "../lookup.ts";

const { test } = Test.make({ providers: GCP.providers() });

const tags = ["provider:gcp", "provider:gcp:networkmanagement", "live"];

// A lookup of a resource that doesn't exist fails the deploy with
// LookupNotFoundError.
test.provider(
  "a lookup of a missing resource fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectAllMissing(stack, {
        "missing-connectivity-test": GCP.NetworkManagement.ConnectivityTest.lookup({ testId: name })
          .name,
        "missing-network-monitoring-provider":
          GCP.NetworkManagement.NetworkMonitoringProvider.lookup({
            networkMonitoringProviderId: name,
          }).name,
        "missing-vpc-flow-logs-config": GCP.NetworkManagement.VpcFlowLogsConfig.lookup({
          vpcFlowLogsConfigId: name,
        }).name,
      });
    }),
  { tags, timeout: 105000 },
);
