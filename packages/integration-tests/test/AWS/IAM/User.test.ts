import * as AWS from "@alchemy.run/aws";
import { User } from "@alchemy.run/aws/IAM";
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
  "list enumerates the deployed user",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const user = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* User("ListUser", {
            tags: {
              env: "test",
            },
          });
        }),
      );

      const provider = yield* Provider.findProvider(User);
      const all = yield* provider.list();

      const found = all.find((u) => u.userName === user.userName);
      expect(found).toBeDefined();
      expect(found?.userArn).toBe(user.userArn);

      yield* stack.destroy();

      const deleted = yield* IAM.getUser({
        UserName: user.userName,
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

      const deploy = (action: "s3:ListBucket" | "s3:GetObject", env: string) =>
        stack.deploy(
          Effect.gen(function* () {
            return yield* User("EquivalentInlineUser", {
              inlinePolicies: {
                Inline: {
                  Version: "2012-10-17",
                  Statement: [{ Effect: "Allow", Action: [action], Resource: "*" }],
                },
              },
              tags: { env },
            });
          }),
        );

      const user = yield* deploy("s3:ListBucket", "before");
      const subject = { UserName: user.userName };
      const input = { ...subject, PolicyName: "Inline" };
      const readDocument = IAM.getUserPolicy(input).pipe(
        Effect.map(({ PolicyDocument }) => decodeIamPolicyDocument(PolicyDocument)),
      );
      // Verify IAM distinguishes the two stored shapes, so an unwanted
      // rewrite cannot pass the readback assertion.
      const declared = yield* readDocument;
      expect(declared.Statement[0].Action).toEqual(["s3:ListBucket"]);
      yield* IAM.putUserPolicy({ ...input, PolicyDocument: equivalentPolicyJson });
      expect(yield* readDocument).toEqual(equivalentPolicyDocument);

      yield* deploy("s3:ListBucket", "after");
      expect(yield* readDocument).toEqual(equivalentPolicyDocument);
      const { Tags } = yield* IAM.listUserTags(subject);
      expect(Tags).toContainEqual({ Key: "env", Value: "after" });

      yield* deploy("s3:GetObject", "after");
      const changed = yield* readDocument;
      expect(["s3:GetObject", ["s3:GetObject"]]).toContainEqual(changed.Statement[0].Action);

      yield* stack.destroy();
      const deleted = yield* IAM.getUser(subject).pipe(
        Effect.catchTag("NoSuchEntityException", () => Effect.undefined),
      );
      expect(deleted).toBeUndefined();
    }),
  { tags: ["provider:aws", "provider:aws:iam", "live"] },
);
