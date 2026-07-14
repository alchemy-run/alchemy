import * as AWS from "@/AWS";
import { AWSEnvironment } from "@/AWS/Environment.ts";
import {
  normalizePolicyDocument,
  type PolicyDocument,
} from "@/AWS/IAM/Policy.ts";
import { Registry } from "@/AWS/Schemas";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Vitest";
import * as schemas from "@distilled.cloud/aws/schemas";
import { describe, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

const assertRegistryGone = (registryName: string) =>
  schemas.describeRegistry({ RegistryName: registryName }).pipe(
    Effect.flatMap(() =>
      Effect.fail(new Error(`registry ${registryName} still exists`)),
    ),
    Effect.catchTag("NotFoundException", () => Effect.void),
    Effect.retry({
      while: (e) => e instanceof Error,
      schedule: Schedule.max([
        Schedule.fixed("2 seconds"),
        Schedule.recurs(10),
      ]),
    }),
  );

describe("AWS.Schemas.Registry", () => {
  test.provider(
    "creates, updates, replaces on rename, and deletes a registry",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        // CREATE
        const created = yield* stack.deploy(
          Effect.gen(function* () {
            const registry = yield* Registry("TestRegistry", {
              description: "alchemy schemas test registry",
              tags: { purpose: "alchemy-test" },
            });
            return {
              registryName: registry.registryName,
              registryArn: registry.registryArn,
            };
          }),
        );

        // Verify out-of-band via distilled.
        const observed = yield* schemas.describeRegistry({
          RegistryName: created.registryName,
        });
        expect(observed.RegistryArn).toEqual(created.registryArn);
        expect(observed.Description).toEqual("alchemy schemas test registry");
        expect(observed.Tags?.purpose).toEqual("alchemy-test");
        expect(observed.Tags?.["alchemy::id"]).toEqual("TestRegistry");

        // list() enumerates the deployed registry (LOCAL scope only).
        const provider = yield* Provider.findProvider(Registry);
        const all = yield* provider.list();
        expect(all.some((r) => r.registryName === created.registryName)).toBe(
          true,
        );
        expect(all.some((r) => r.registryName === "aws.events")).toBe(false);

        // POLICY — attach a PolicyDocument-valued resource policy in place.
        const { accountId } = yield* AWSEnvironment.current;
        const policy: PolicyDocument = {
          Version: "2012-10-17",
          Statement: [
            {
              Sid: "AllowOwnAccountRead",
              Effect: "Allow",
              Principal: { AWS: `arn:aws:iam::${accountId}:root` },
              Action: ["schemas:DescribeRegistry", "schemas:SearchSchemas"],
              Resource: created.registryArn,
            },
          ],
        };
        const deployWithPolicy = stack.deploy(
          Effect.gen(function* () {
            const registry = yield* Registry("TestRegistry", {
              description: "alchemy schemas test registry",
              tags: { purpose: "alchemy-test" },
              policy,
            });
            return { registryName: registry.registryName };
          }),
        );
        const withPolicy = yield* deployWithPolicy;
        expect(withPolicy.registryName).toEqual(created.registryName);

        const observedPolicy = yield* schemas.getResourcePolicy({
          RegistryName: created.registryName,
        });
        expect(normalizePolicyDocument(observedPolicy.Policy!)).toEqual(
          normalizePolicyDocument(policy),
        );

        // NO-OP RE-DEPLOY — the same PolicyDocument deploys clean and skips
        // putResourcePolicy entirely (the revision id is unchanged).
        yield* deployWithPolicy;
        const afterRedeploy = yield* schemas.getResourcePolicy({
          RegistryName: created.registryName,
        });
        expect(afterRedeploy.RevisionId).toEqual(observedPolicy.RevisionId);
        expect(normalizePolicyDocument(afterRedeploy.Policy!)).toEqual(
          normalizePolicyDocument(policy),
        );

        // UPDATE — description changes in place, user tag is removed.
        const updated = yield* stack.deploy(
          Effect.gen(function* () {
            const registry = yield* Registry("TestRegistry", {
              description: "updated description",
            });
            return {
              registryName: registry.registryName,
              registryArn: registry.registryArn,
            };
          }),
        );
        expect(updated.registryName).toEqual(created.registryName);

        const afterUpdate = yield* schemas.describeRegistry({
          RegistryName: created.registryName,
        });
        expect(afterUpdate.Description).toEqual("updated description");
        expect(afterUpdate.Tags?.purpose).toBeUndefined();
        expect(afterUpdate.Tags?.["alchemy::id"]).toEqual("TestRegistry");

        // Omitting `policy` removed the resource policy.
        const policyGone = yield* schemas
          .getResourcePolicy({ RegistryName: created.registryName })
          .pipe(
            Effect.map(() => false),
            Effect.catchTag("NotFoundException", () => Effect.succeed(true)),
          );
        expect(policyGone).toBe(true);

        // REPLACE — an explicit name change replaces the registry.
        const renamed = yield* stack.deploy(
          Effect.gen(function* () {
            const registry = yield* Registry("TestRegistry", {
              registryName: "alchemy-test-schemas-registry-renamed",
            });
            return {
              registryName: registry.registryName,
              registryArn: registry.registryArn,
            };
          }),
        );
        expect(renamed.registryName).toEqual(
          "alchemy-test-schemas-registry-renamed",
        );
        yield* assertRegistryGone(created.registryName);
        const afterRename = yield* schemas.describeRegistry({
          RegistryName: renamed.registryName,
        });
        expect(afterRename.RegistryArn).toEqual(renamed.registryArn);

        // DELETE
        yield* stack.destroy();
        yield* assertRegistryGone(renamed.registryName);
      }),
    { timeout: 120_000 },
  );
});
