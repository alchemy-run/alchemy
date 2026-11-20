import * as AWS from "@alchemy.run/aws";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as codeartifact from "@distilled.cloud/aws/codeartifact";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import { expectDeployFails, missingName } from "../../lookup.ts";
import { expectLookupConsumers } from "../lookup.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: AWS.providers(),
});

const tags = ["provider:aws", "provider:aws:codeartifact", "live"];

// The target belongs to another stack, as a lookup's target always should.
const TargetStack = Alchemy.Stack(
  "CodeArtifactLookupTarget",
  { providers: AWS.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const domain = yield* AWS.CodeArtifact.Domain("lookup-target");
    const repo = yield* AWS.CodeArtifact.Repository("lookup-target-repo", {
      domain: domain.domainName,
    });
    return {
      domainName: domain.domainName.as<string>(),
      domainArn: domain.domainArn.as<string>(),
      repositoryName: repo.repositoryName.as<string>(),
      repositoryArn: repo.repositoryArn.as<string>(),
    };
  }),
);

const target = beforeAll(deploy(TargetStack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(TargetStack));

test.provider(
  "domains and repositories resolve by name, and survive destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { domainName, domainArn, repositoryName, repositoryArn } = yield* target;
      yield* expectLookupConsumers(
        stack,
        () => {
          return {
            domain: AWS.CodeArtifact.Domain.lookup({ domainName }).domainArn,
            repo: AWS.CodeArtifact.Repository.lookup({ domainName, repositoryName }).repositoryArn,
          };
        },
        {
          domain: domainArn,
          repo: repositoryArn,
        },
      );
      const survivor = yield* codeartifact.describeDomain({ domain: domainName });
      expect(survivor.domain?.arn).toBe(domainArn);
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a lookup of a missing domain fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      const lookups = {
        "missing-domain": AWS.CodeArtifact.Domain.lookup({ domainName: name }).domainArn,
      };
      for (const [id, value] of Object.entries(lookups)) {
        yield* expectDeployFails(stack.deploy(AWS.SSM.Parameter(id, { value })), [
          "LookupNotFoundError",
        ]);
      }
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a lookup of a domain this stack manages fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const managed = () => AWS.CodeArtifact.Domain("lookup-managed");
      const attrs = yield* stack.deploy(managed());
      yield* expectDeployFails(
        stack.deploy(
          Effect.gen(function* () {
            yield* managed();
            yield* AWS.SSM.Parameter("managed-domain-consumer", {
              value: AWS.CodeArtifact.Domain.lookup({ domainName: attrs.domainName }).domainArn,
            });
          }),
        ),
        ["LookupOfManagedResourceError", "lookup-managed"],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);
