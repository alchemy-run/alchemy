import * as GCP from "@alchemy.run/gcp";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { missingName } from "../../lookup.ts";
import { expectAllMissing } from "../lookup.ts";

const { test } = Test.make({ providers: GCP.providers() });

const tags = ["provider:gcp", "provider:gcp:servicedirectory", "live"];

// A lookup of a resource that doesn't exist fails the deploy with
// LookupNotFoundError.
test.provider(
  "a lookup of a missing resource fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectAllMissing(stack, {
        "missing-endpoint": GCP.ServiceDirectory.Endpoint.lookup({
          endpointId: name,
          service: name,
        }).name,
        "missing-namespace": GCP.ServiceDirectory.Namespace.lookup({ namespaceId: name }).name,
        "missing-service": GCP.ServiceDirectory.Service.lookup({ serviceId: name, namespace: name })
          .name,
      });
    }),
  { tags, timeout: 105000 },
);
