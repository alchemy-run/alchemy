import * as AWS from "@alchemy.run/aws";
import { Policy } from "@alchemy.run/aws/IAM";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as IAM from "@distilled.cloud/aws/iam";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import { equivalentPolicyJson } from "./fixtures.ts";

const { test } = Test.make({ providers: AWS.providers() });

test.provider(
  "create, update, and delete managed policy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const policy = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Policy("IamPolicy", {
            policyDocument: {
              Version: "2012-10-17",
              Statement: [{ Effect: "Allow", Action: ["s3:ListBucket"], Resource: ["*"] }],
            },
            tags: { env: "test" },
          });
        }),
      );

      const created = yield* IAM.getPolicy({ PolicyArn: policy.policyArn });
      expect(created.Policy?.PolicyName).toBe(policy.policyName);

      yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Policy("IamPolicy", {
            policyDocument: {
              Version: "2012-10-17",
              Statement: [{ Effect: "Allow", Action: ["s3:GetObject"], Resource: ["*"] }],
            },
            tags: { env: "prod" },
          });
        }),
      );

      const updatedTags = yield* IAM.listPolicyTags({ PolicyArn: policy.policyArn });
      expect(
        Object.fromEntries((updatedTags.Tags ?? []).map((tag) => [tag.Key, tag.Value])),
      ).toMatchObject({ env: "prod" });

      yield* stack.destroy();

      const deleted = yield* IAM.getPolicy({ PolicyArn: policy.policyArn }).pipe(Effect.option);
      expect(deleted._tag).toBe("None");
    }),
  { tags: ["provider:aws", "provider:aws:iam", "live"] },
);

test.provider(
  "rotates policy versions past the 5-version cap",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployWith = (actions: [string, ...string[]]) =>
        stack.deploy(
          Effect.gen(function* () {
            return yield* Policy("VersionCapPolicy", {
              policyDocument: {
                Version: "2012-10-17",
                Statement: [{ Effect: "Allow", Action: actions, Resource: ["*"] }],
              },
            });
          }),
        );

      // 1 create + 6 document updates = 7 versions requested; IAM caps
      // managed policies at 5 versions, so the provider must prune the
      // oldest non-default version before each rotation past the cap.
      const documents: [string, ...string[]][] = [
        ["s3:ListBucket"],
        ["s3:GetObject"],
        ["s3:PutObject"],
        ["s3:DeleteObject"],
        ["s3:GetObjectTagging"],
        ["s3:PutObjectTagging"],
        ["s3:GetBucketLocation"],
      ];
      let policy: { policyArn: string } | undefined;
      for (const actions of documents) {
        policy = yield* deployWith(actions);
      }

      const versions = yield* IAM.listPolicyVersions({ PolicyArn: policy!.policyArn });
      expect(versions.Versions?.length ?? 0).toBeLessThanOrEqual(5);

      // The default version must carry the last document.
      const defaultVersion = versions.Versions?.find((version) => version.IsDefaultVersion);
      expect(defaultVersion?.VersionId).toBeDefined();
      const document = yield* IAM.getPolicyVersion({
        PolicyArn: policy!.policyArn,
        VersionId: defaultVersion!.VersionId!,
      });
      const decoded = JSON.parse(decodeURIComponent(document.PolicyVersion?.Document ?? "")) as {
        Statement: [{ Action: string[] }];
      };
      expect(decoded.Statement[0].Action).toEqual(["s3:GetBucketLocation"]);

      yield* stack.destroy();

      const deleted = yield* IAM.getPolicy({ PolicyArn: policy!.policyArn }).pipe(Effect.option);
      expect(deleted._tag).toBe("None");
    }),
  { tags: ["provider:aws", "provider:aws:iam", "live"], timeout: 120_000 },
);

test.provider(
  "list enumerates the deployed policy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Policy("ListPolicy", {
            policyDocument: {
              Version: "2012-10-17",
              Statement: [{ Effect: "Allow", Action: ["s3:ListBucket"], Resource: ["*"] }],
            },
          });
        }),
      );

      const provider = yield* Provider.findProvider(Policy);
      const all = yield* provider.list();

      expect(all.some((p) => p.policyArn === deployed.policyArn)).toBe(true);

      yield* stack.destroy();
    }),
  { tags: ["provider:aws", "provider:aws:iam", "live"] },
);

test.provider(
  "does not create a new version for an equivalent document",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deploy = (action: "s3:ListBucket" | "s3:GetObject", env: string) =>
        stack.deploy(
          Effect.gen(function* () {
            return yield* Policy("EquivalentPolicy", {
              policyDocument: {
                Version: "2012-10-17",
                Statement: [{ Effect: "Allow", Action: [action], Resource: "*" }],
              },
              tags: { env },
            });
          }),
        );

      const policy = yield* deploy("s3:ListBucket", "before");
      const input = { PolicyArn: policy.policyArn };
      const seeded = yield* IAM.createPolicyVersion({
        ...input,
        PolicyDocument: equivalentPolicyJson,
        SetAsDefault: true,
      });
      const seededId = seeded.PolicyVersion?.VersionId;
      expect(seededId).toBeDefined();
      const { PolicyVersion: observedSeed } = yield* IAM.getPolicyVersion({
        ...input,
        VersionId: seededId!,
      });
      expect(JSON.parse(decodeURIComponent(observedSeed?.Document ?? ""))).toEqual(
        JSON.parse(equivalentPolicyJson),
      );

      const getVersions = IAM.listPolicyVersions(input).pipe(
        Effect.map((result) =>
          (result.Versions ?? [])
            .map(({ VersionId, IsDefaultVersion }) => ({
              VersionId,
              IsDefaultVersion,
            }))
            .sort((a, b) => (a.VersionId ?? "").localeCompare(b.VersionId ?? "")),
        ),
      );
      const before = yield* getVersions;
      expect(before).toContainEqual({ VersionId: seededId, IsDefaultVersion: true });

      yield* deploy("s3:ListBucket", "after");
      expect(yield* getVersions).toEqual(before);
      const { Tags } = yield* IAM.listPolicyTags(input);
      expect(Tags).toContainEqual({ Key: "env", Value: "after" });

      yield* deploy("s3:GetObject", "after");
      const after = yield* getVersions;
      expect(after).toHaveLength(before.length + 1);
      const changedId = after.find((version) => version.IsDefaultVersion)?.VersionId;
      expect(changedId).toBeDefined();
      expect(changedId).not.toBe(seededId);
      const { PolicyVersion } = yield* IAM.getPolicyVersion({ ...input, VersionId: changedId! });
      const changed = JSON.parse(decodeURIComponent(PolicyVersion?.Document ?? ""));
      expect(["s3:GetObject", ["s3:GetObject"]]).toContainEqual(changed.Statement[0].Action);

      yield* stack.destroy();
      const deleted = yield* IAM.getPolicy(input).pipe(
        Effect.catchTag("NoSuchEntityException", () => Effect.undefined),
      );
      expect(deleted).toBeUndefined();
    }),
  { tags: ["provider:aws", "provider:aws:iam", "live"] },
);
