import type { PolicyDocument } from "@/AWS/IAM/Policy.ts";
import { normalizePolicyDocument } from "@/AWS/IAM/Policy.ts";
import { expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  describeInstance,
  instance,
  instanceId,
  props,
  reconcile,
  response,
  withInstance,
} from "./DBInstance.provider.ts";

const secretArn =
  "arn:aws:secretsmanager:us-east-1:123456789012:secret:rds!db-instance-abcdef";
const policy: PolicyDocument = {
  Version: "2012-10-17",
  Statement: [
    {
      Effect: "Allow",
      Principal: { AWS: "arn:aws:iam::123456789012:role/reader" },
      Action: ["secretsmanager:GetSecretValue"],
      Resource: "*",
    },
  ],
};
const managed = instance({
  MasterUserSecret: { SecretArn: secretArn, SecretStatus: "active" },
});
const news = {
  ...props,
  manageMasterUserPassword: true,
  masterUserSecretResourcePolicy: policy,
};
const json = (body: object, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/x-amz-json-1.1" },
  });

it.effect(
  "new instances wait for the RDS-managed secret and its policy metadata",
  () => {
    let created = false;
    let instanceReads = 0;
    let policyReads = 0;
    let written = false;
    return withInstance(
      ({ action }) => {
        if (action === "DescribeDBInstances") {
          instanceReads++;
          return describeInstance(
            !created ? undefined : instanceReads < 4 ? instance() : managed,
          );
        }
        if (action === "CreateDBInstance") {
          created = true;
          return response(action, "");
        }
        if (action === "GetResourcePolicy") {
          if (++policyReads === 1)
            return json(
              {
                __type: "ResourceNotFoundException",
                Message: "Not visible yet",
              },
              400,
            );
          return json(
            written ? { ResourcePolicy: JSON.stringify(policy) } : {},
          );
        }
        if (action === "PutResourcePolicy") {
          written = true;
          return json({ ARN: secretArn });
        }
        throw new Error(`Unexpected operation: ${action}`);
      },
      (provider, requests) =>
        Effect.gen(function* () {
          const result = yield* reconcile(provider, news);
          expect(result.masterUserSecretArn).toBe(secretArn);
          expect(result.masterUserSecretResourcePolicy).toBe(
            normalizePolicyDocument(policy),
          );
          const creates = requests.filter(
            ({ action }) => action === "CreateDBInstance",
          );
          expect(creates).toHaveLength(1);
          expect(creates[0]!.parameters.get("ManageMasterUserPassword")).toBe(
            "true",
          );
          expect(
            requests.filter(({ action }) => action === "PutResourcePolicy"),
          ).toHaveLength(1);
          expect(
            requests.filter(({ action }) => action === "GetResourcePolicy"),
          ).toHaveLength(3);
        }),
    );
  },
  { timeout: 5000 },
);

it.effect(
  "policy convergence stops after its retry budget without rewriting",
  () =>
    withInstance(
      ({ action }) => {
        if (action === "DescribeDBInstances") return describeInstance(managed);
        if (action === "GetResourcePolicy" || action === "PutResourcePolicy")
          return json({});
        throw new Error(`Unexpected operation: ${action}`);
      },
      (provider, requests) =>
        Effect.gen(function* () {
          const error = yield* reconcile(provider, news).pipe(Effect.flip);
          expect(error._tag).toBe("DBInstanceSecretPolicyPending");
          expect(
            requests.filter(({ action }) => action === "PutResourcePolicy"),
          ).toHaveLength(1);
          expect(
            requests.filter(({ action }) => action === "GetResourcePolicy"),
          ).toHaveLength(12);
        }),
    ),
  { timeout: 5000 },
);

it.effect(
  "equivalent observed policy skips writes and reads no secret values",
  () =>
    withInstance(
      ({ action }) => {
        if (action === "DescribeDBInstances") return describeInstance(managed);
        if (action === "GetResourcePolicy")
          return json({ ResourcePolicy: JSON.stringify(policy, null, 2) });
        throw new Error(`Unexpected operation: ${action}`);
      },
      (provider, requests) =>
        Effect.gen(function* () {
          const result = yield* reconcile(provider, news);
          expect(result.masterUserSecretResourcePolicy).toBe(
            normalizePolicyDocument(policy),
          );
          expect(
            requests.filter(({ action }) => action === "GetResourcePolicy"),
          ).toHaveLength(1);
        }),
    ),
  { timeout: 5000 },
);

it.effect(
  "writes a private resource policy once and waits for readback",
  () => {
    let policyReads = 0;
    return withInstance(
      ({ action }) => {
        if (action === "DescribeDBInstances") return describeInstance(managed);
        if (action === "GetResourcePolicy")
          return json(
            ++policyReads >= 3
              ? { ResourcePolicy: JSON.stringify(policy) }
              : {},
          );
        if (action === "PutResourcePolicy") return json({ ARN: secretArn });
        throw new Error(`Unexpected operation: ${action}`);
      },
      (provider, requests) =>
        Effect.gen(function* () {
          const result = yield* reconcile(provider, news);
          expect(result.masterUserSecretResourcePolicy).toBe(
            normalizePolicyDocument(policy),
          );
          const puts = requests.filter(
            ({ action }) => action === "PutResourcePolicy",
          );
          expect(puts).toHaveLength(1);
          expect(JSON.parse(puts[0]!.body)).toEqual({
            SecretId: secretArn,
            ResourcePolicy: JSON.stringify(policy),
            BlockPublicPolicy: true,
          });
        }),
    );
  },
  { timeout: 5000 },
);

it.effect(
  "omitting policy management leaves the RDS-managed secret alone",
  () =>
    withInstance(
      ({ action }) => {
        if (action === "DescribeDBInstances") return describeInstance(managed);
        throw new Error(`Unexpected operation: ${action}`);
      },
      (provider) =>
        Effect.gen(function* () {
          const result = yield* reconcile(provider, props);
          expect(result.masterUserSecretResourcePolicy).toBeUndefined();
          expect(result.masterUserSecretArn).toBe(secretArn);
        }),
    ),
  { timeout: 5000 },
);

it.effect(
  "a missing managed secret is a typed configuration failure",
  () =>
    withInstance(
      () => describeInstance(instance()),
      (provider, requests) =>
        Effect.gen(function* () {
          const error = yield* reconcile(provider, news).pipe(Effect.flip);
          expect(error._tag).toBe("DBInstanceManagedSecretMissing");
          expect(
            requests.every(({ action }) => action === "DescribeDBInstances"),
          ).toBe(true);
        }),
    ),
  { timeout: 5000 },
);

it.effect(
  "policy reads preserve authorization failures without retries or writes",
  () =>
    withInstance(
      ({ action }) =>
        action === "DescribeDBInstances"
          ? describeInstance(managed)
          : json(
              { __type: "AccessDeniedException", Message: "Access denied" },
              400,
            ),
      (provider, requests) =>
        Effect.gen(function* () {
          const error = yield* reconcile(provider, news).pipe(Effect.flip);
          expect(error._tag).not.toBe("DBInstanceSecretPolicyPending");
          expect(
            requests.filter(({ action }) => action === "GetResourcePolicy"),
          ).toHaveLength(1);
          expect(
            requests.some(({ action }) => action === "PutResourcePolicy"),
          ).toBe(false);
        }),
    ),
  { timeout: 5000 },
);

it.effect(
  "unchanged props still detect live policy drift",
  () => {
    let drifted = false;
    return withInstance(
      ({ action }) => {
        if (action === "DescribeDBInstances") return describeInstance(managed);
        if (action === "GetResourcePolicy")
          return json(
            drifted ? {} : { ResourcePolicy: JSON.stringify(policy) },
          );
        throw new Error(`Unexpected operation: ${action}`);
      },
      (provider) =>
        Effect.gen(function* () {
          const output = yield* provider.read!({
            id: "Db",
            fqn: "Db",
            instanceId,
            olds: news,
            output: undefined,
          });
          drifted = true;
          const diff = yield* provider.diff!({
            id: "Db",
            fqn: "Db",
            instanceId,
            olds: news,
            news,
            output,
            oldBindings: [],
            newBindings: [],
          });
          expect(diff).toEqual({ action: "update" });
        }),
    );
  },
  { timeout: 5000 },
);
