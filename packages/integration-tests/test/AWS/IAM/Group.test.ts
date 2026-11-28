import * as AWS from "@alchemy.run/aws";
import { Group, Policy } from "@alchemy.run/aws/IAM";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as IAM from "@distilled.cloud/aws/iam";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import {
  decodeIamPolicyDocument,
  equivalentPolicyDocument,
  equivalentPolicyJson,
} from "./fixtures.ts";

const { test } = Test.make({ providers: AWS.providers() });

test.provider(
  "list enumerates the deployed group",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const group = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Group("ListGroup", {
            groupName: "alchemy-test-group-list",
            inlinePolicies: {
              SupportReadOnly: {
                Version: "2012-10-17",
                Statement: [
                  {
                    Effect: "Allow",
                    Action: ["cloudwatch:Get*", "cloudwatch:List*"],
                    Resource: ["*"],
                  },
                ],
              },
            },
          });
        }),
      );

      const provider = yield* Provider.findProvider(Group);
      const all = yield* provider.list();

      const found = all.find((g) => g.groupName === group.groupName);
      expect(found).toBeDefined();
      expect(found?.groupArn).toBe(group.groupArn);
      expect(found?.inlinePolicies.SupportReadOnly).toBeDefined();

      yield* stack.destroy();

      const deleted = yield* IAM.getGroup({
        GroupName: group.groupName,
      }).pipe(Effect.option);
      expect(deleted._tag).toBe("None");
    }),
  { tags: ["provider:aws", "provider:aws:iam", "live"] },
);

test.provider(
  "does not rewrite an equivalent inline policy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deploy = (action: "s3:ListBucket" | "s3:GetObject", attach: boolean) =>
        stack.deploy(
          Effect.gen(function* () {
            const managed = yield* Policy("Attachment", {
              policyDocument: {
                Version: "2012-10-17",
                Statement: [{ Effect: "Deny", Action: ["s3:DeleteBucket"], Resource: "*" }],
              },
            });
            const group = yield* Group("EquivalentInlineGroup", {
              inlinePolicies: {
                Inline: {
                  Version: "2012-10-17",
                  Statement: [{ Effect: "Allow", Action: [action], Resource: "*" }],
                },
              },
              managedPolicyArns: attach ? [managed.policyArn] : [],
            });
            return { group, attachmentArn: managed.policyArn };
          }),
        );

      const { group, attachmentArn } = yield* deploy("s3:ListBucket", false);
      const subject = { GroupName: group.groupName };
      const input = { ...subject, PolicyName: "Inline" };
      const readDocument = IAM.getGroupPolicy(input).pipe(
        Effect.map(({ PolicyDocument }) => decodeIamPolicyDocument(PolicyDocument)),
      );
      // Verify IAM distinguishes the two stored shapes, so an unwanted
      // rewrite cannot pass the readback assertion.
      const declared = yield* readDocument;
      expect(declared.Statement[0].Action).toEqual(["s3:ListBucket"]);
      yield* IAM.putGroupPolicy({ ...input, PolicyDocument: equivalentPolicyJson });
      expect(yield* readDocument).toEqual(equivalentPolicyDocument);

      yield* deploy("s3:ListBucket", true);
      expect(yield* readDocument).toEqual(equivalentPolicyDocument);
      const { AttachedPolicies } = yield* IAM.listAttachedGroupPolicies(subject);
      expect(AttachedPolicies?.map((policy) => policy.PolicyArn)).toEqual([attachmentArn]);

      yield* deploy("s3:GetObject", true);
      const changed = yield* readDocument;
      expect(["s3:GetObject", ["s3:GetObject"]]).toContainEqual(changed.Statement[0].Action);

      yield* stack.destroy();
      const deleted = yield* IAM.getGroup(subject).pipe(
        Effect.catchTag("NoSuchEntityException", () => Effect.undefined),
      );
      expect(deleted).toBeUndefined();
    }),
  { tags: ["provider:aws", "provider:aws:iam", "live"] },
);
