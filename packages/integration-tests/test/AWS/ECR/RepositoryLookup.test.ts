import * as AWS from "@alchemy.run/aws";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as ecr from "@distilled.cloud/aws/ecr";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import { expectDeployFails, missingName } from "../../lookup.ts";
import { expectLookupConsumers } from "../lookup.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: AWS.providers(),
});

const tags = ["provider:aws", "provider:aws:ecr", "live"];

// The target belongs to another stack, as a lookup's target always should.
const TargetStack = Alchemy.Stack(
  "RepositoryLookupTarget",
  { providers: AWS.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const repo = yield* AWS.ECR.Repository("lookup-target");
    return {
      repositoryName: repo.repositoryName.as<string>(),
      repositoryUri: repo.repositoryUri.as<string>(),
    };
  }),
);

const target = beforeAll(deploy(TargetStack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(TargetStack));

test.provider(
  "a looked-up repository resolves by name, and survives destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { repositoryName, repositoryUri } = yield* target;
      yield* expectLookupConsumers(
        stack,
        () => {
          const repo = AWS.ECR.Repository.lookup({ repositoryName });
          return { uri: repo.repositoryUri };
        },
        {
          uri: repositoryUri,
        },
      );
      const survivor = yield* ecr.describeRepositories({ repositoryNames: [repositoryName] });
      expect(survivor.repositories?.[0]?.repositoryUri).toBe(repositoryUri);
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a lookup of a missing repository fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectDeployFails(
        stack.deploy(
          AWS.SSM.Parameter("missing-repository", {
            value: AWS.ECR.Repository.lookup({ repositoryName: name }).repositoryUri,
          }),
        ),
        ["LookupNotFoundError", name],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a lookup of a repository this stack manages fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const managed = () => AWS.ECR.Repository("lookup-managed");
      const attrs = yield* stack.deploy(managed());
      yield* expectDeployFails(
        stack.deploy(
          Effect.gen(function* () {
            yield* managed();
            yield* AWS.SSM.Parameter("managed-repository-consumer", {
              value: AWS.ECR.Repository.lookup({ repositoryName: attrs.repositoryName })
                .repositoryUri,
            });
          }),
        ),
        ["LookupOfManagedResourceError", "lookup-managed"],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);
