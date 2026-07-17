import * as AWS from "@/AWS";
import { Policy } from "@/AWS/IAM";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as IAM from "@distilled.cloud/aws/iam";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

test.provider("create, update, and delete managed policy", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const policy = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Policy("IamPolicy", {
          policyDocument: {
            Version: "2012-10-17",
            Statement: [
              {
                Effect: "Allow",
                Action: ["s3:ListBucket"],
                Resource: ["*"],
              },
            ],
          },
          tags: {
            env: "test",
          },
        });
      }),
    );

    const created = yield* IAM.getPolicy({
      PolicyArn: policy.policyArn,
    });
    expect(created.Policy?.PolicyName).toBe(policy.policyName);

    yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Policy("IamPolicy", {
          policyDocument: {
            Version: "2012-10-17",
            Statement: [
              {
                Effect: "Allow",
                Action: ["s3:GetObject"],
                Resource: ["*"],
              },
            ],
          },
          tags: {
            env: "prod",
          },
        });
      }),
    );

    const updatedTags = yield* IAM.listPolicyTags({
      PolicyArn: policy.policyArn,
    });
    expect(
      Object.fromEntries(
        (updatedTags.Tags ?? []).map((tag) => [tag.Key, tag.Value]),
      ),
    ).toMatchObject({
      env: "prod",
    });

    yield* stack.destroy();

    const deleted = yield* IAM.getPolicy({
      PolicyArn: policy.policyArn,
    }).pipe(Effect.option);
    expect(deleted._tag).toBe("None");
  }),
);

test.provider("list enumerates the deployed policy", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const deployed = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Policy("ListPolicy", {
          policyDocument: {
            Version: "2012-10-17",
            Statement: [
              {
                Effect: "Allow",
                Action: ["s3:ListBucket"],
                Resource: ["*"],
              },
            ],
          },
        });
      }),
    );

    const provider = yield* Provider.findProvider(Policy);
    const all = yield* provider.list();

    expect(all.some((p) => p.policyArn === deployed.policyArn)).toBe(true);

    yield* stack.destroy();
  }),
);
