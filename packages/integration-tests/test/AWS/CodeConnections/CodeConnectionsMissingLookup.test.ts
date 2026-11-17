import * as AWS from "@alchemy.run/aws";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { missingName } from "../../lookup.ts";
import { expectAllMissing } from "../lookup.ts";

const { test } = Test.make({ providers: AWS.providers() });

const tags = ["provider:aws", "provider:aws:codeconnections", "live"];

// A lookup of a resource that doesn't exist fails the deploy with
// LookupNotFoundError (connection, host, repository link).
test.provider(
  "a lookup of a missing resource fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectAllMissing(stack, {
        "missing-connection": AWS.CodeConnections.Connection.lookup({ connectionName: name })
          .connectionName,
        "missing-host": AWS.CodeConnections.Host.lookup({ hostName: name }).hostName,
        "missing-repository-link": AWS.CodeConnections.RepositoryLink.lookup({
          repositoryLinkId: "11111111-1111-4111-8111-111111111111",
        }).repositoryLinkId,
      });
    }),
  { tags, timeout: 180_000 },
);
