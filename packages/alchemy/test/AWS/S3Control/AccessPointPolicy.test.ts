import * as AWS from "@/AWS";
import { Bucket } from "@/AWS/S3";
import { AccessPoint, AccessPointPolicy } from "@/AWS/S3Control";
import * as Output from "@/Output";
import * as Test from "@/Test/Vitest";
import * as s3control from "@distilled.cloud/aws/s3-control";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

const ACCOUNT_ID = "391965393224";

const findPolicy = (name: string) =>
  s3control.getAccessPointPolicy({ AccountId: ACCOUNT_ID, Name: name }).pipe(
    Effect.map((r) => r.Policy),
    Effect.catchTag(["NoSuchAccessPointPolicy", "NoSuchAccessPoint"], () =>
      Effect.succeed(undefined),
    ),
  );

test.provider(
  "create, update, delete access point policy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* Bucket("PolicyBucket", { forceDestroy: true });
          const accessPoint = yield* AccessPoint("PolicyAp", {
            bucket: bucket.bucketName,
          });
          yield* AccessPointPolicy("PolicyApPolicy", {
            accessPointName: accessPoint.accessPointName,
            policy: [
              {
                Effect: "Allow",
                Principal: { AWS: `arn:aws:iam::${ACCOUNT_ID}:root` },
                Action: ["s3:GetObject"],
                Resource: Output.interpolate`${accessPoint.accessPointArn}/object/*`,
              },
            ],
          });
          return { accessPoint };
        }),
      );

      // out-of-band verification via distilled
      const policy = yield* findPolicy(deployed.accessPoint.accessPointName);
      expect(policy).toBeDefined();
      const parsed = JSON.parse(policy!) as {
        Statement: { Action: string | string[] }[];
      };
      expect(parsed.Statement).toHaveLength(1);
      // AWS normalizes stored policies (single-element arrays collapse to
      // plain strings), so compare the normalized form.
      const actions = parsed.Statement[0].Action;
      expect(Array.isArray(actions) ? actions : [actions]).toEqual([
        "s3:GetObject",
      ]);

      // update the policy document in place
      yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* Bucket("PolicyBucket", { forceDestroy: true });
          const accessPoint = yield* AccessPoint("PolicyAp", {
            bucket: bucket.bucketName,
          });
          yield* AccessPointPolicy("PolicyApPolicy", {
            accessPointName: accessPoint.accessPointName,
            policy: [
              {
                Effect: "Allow",
                Principal: { AWS: `arn:aws:iam::${ACCOUNT_ID}:root` },
                Action: ["s3:GetObject"],
                Resource: Output.interpolate`${accessPoint.accessPointArn}/object/*`,
              },
              {
                Effect: "Allow",
                Principal: { AWS: `arn:aws:iam::${ACCOUNT_ID}:root` },
                Action: ["s3:ListBucket"],
                Resource: accessPoint.accessPointArn,
              },
            ],
          });
          return { accessPoint };
        }),
      );

      const updatedPolicy = yield* findPolicy(
        deployed.accessPoint.accessPointName,
      );
      const updatedParsed = JSON.parse(updatedPolicy!) as {
        Statement: unknown[];
      };
      expect(updatedParsed.Statement).toHaveLength(2);

      yield* stack.destroy();
      // policy (and its access point) are gone after destroy
      const afterDestroy = yield* findPolicy(
        deployed.accessPoint.accessPointName,
      );
      expect(afterDestroy).toBeUndefined();
    }),
  { timeout: 120_000 },
);
