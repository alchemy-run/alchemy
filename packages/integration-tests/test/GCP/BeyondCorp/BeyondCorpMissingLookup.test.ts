import * as GCP from "@alchemy.run/gcp";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { missingName } from "../../lookup.ts";
import { expectAllMissing } from "../lookup.ts";

const { test } = Test.make({ providers: GCP.providers() });

const tags = ["provider:gcp", "provider:gcp:beyondcorp", "live"];

// A lookup of a resource that doesn't exist fails the deploy with
// LookupNotFoundError.
test.provider(
  "a lookup of a missing resource fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectAllMissing(stack, {
        "missing-app-connection": GCP.BeyondCorp.AppConnection.lookup({ appConnectionId: name })
          .name,
        "missing-app-connector": GCP.BeyondCorp.AppConnector.lookup({ appConnectorId: name }).name,
        "missing-app-gateway": GCP.BeyondCorp.AppGateway.lookup({ appGatewayId: name }).name,
        "missing-security-gateway": GCP.BeyondCorp.SecurityGateway.lookup({
          securityGatewayId: name,
        }).name,
        "missing-security-gateways-application": GCP.BeyondCorp.SecurityGatewaysApplication.lookup({
          applicationId: name,
          securityGateway: name,
        }).name,
      });
    }),
  { tags, timeout: 135000 },
);
