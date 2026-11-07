import * as GCP from "@alchemy.run/gcp";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { missingName } from "../../lookup.ts";
import { expectAllMissing } from "../lookup.ts";

const { test } = Test.make({ providers: GCP.providers() });

const tags = ["provider:gcp", "provider:gcp:container", "live"];

// A lookup of a resource that doesn't exist fails the deploy with
// LookupNotFoundError.
test.provider(
  "a lookup of a missing resource fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectAllMissing(stack, {
        "missing-cluster": GCP.Container.Cluster.lookup({ clusterId: name }).name,
        "missing-clusters-node-pool": GCP.Container.ClustersNodePool.lookup({
          nodePoolId: name,
          cluster: name,
        }).name,
        "missing-node-pool": GCP.Container.NodePool.lookup({ nodePoolId: name, cluster: name })
          .name,
      });
    }),
  { tags, timeout: 105000 },
);
