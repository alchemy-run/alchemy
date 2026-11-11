import * as GCP from "@alchemy.run/gcp";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { missingName } from "../../lookup.ts";
import { expectAllMissing } from "../lookup.ts";

const { test } = Test.make({ providers: GCP.providers() });

const tags = ["provider:gcp", "provider:gcp:developerconnect", "live"];

// A lookup of a resource that doesn't exist fails the deploy with
// LookupNotFoundError.
test.provider(
  "a lookup of a missing resource fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectAllMissing(stack, {
        "missing-account-connector": GCP.DeveloperConnect.AccountConnector.lookup({
          accountConnectorId: name,
        }).name,
        "missing-connection": GCP.DeveloperConnect.Connection.lookup({ connectionId: name }).name,
        "missing-connections-git-repository-link":
          GCP.DeveloperConnect.ConnectionsGitRepositoryLink.lookup({
            gitRepositoryLinkId: name,
            connection: name,
          }).name,
        "missing-insights-config": GCP.DeveloperConnect.InsightsConfig.lookup({
          insightsConfigId: name,
        }).name,
      });
    }),
  { tags, timeout: 120000 },
);
