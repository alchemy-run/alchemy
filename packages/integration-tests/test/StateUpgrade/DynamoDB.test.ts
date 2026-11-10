import * as AWS from "@alchemy.run/aws";
import { makeDynamoDBState } from "@alchemy.run/aws";
import { AWSEnvironment } from "@alchemy.run/aws/Environment";
import { createOverflowBucketName } from "@alchemy.run/aws/StateStore/DynamoDBState";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as dynamodb from "@distilled.cloud/aws/dynamodb";
import * as kms from "@distilled.cloud/aws/kms";
import * as s3 from "@distilled.cloud/aws/s3";
import * as Alchemist from "alchemy/Alchemist";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { awsCiEnv } from "./Aws.ts";
import {
  current,
  deployArgs,
  fails,
  MAIN,
  planLine,
  released,
  RELEASED,
  succeeds,
  workdir,
  type RunOptions,
} from "./Harness.ts";
import {
  expectPlaintext,
  expectSealed,
  secretsOfTexts,
  secretsThroughStore,
  STACK,
  storeNameFor,
} from "./Records.ts";

const { test } = Test.make({ providers: AWS.providers() });

const tags = [
  "provider:aws",
  "provider:aws:dynamodb",
  "provider:aws:kms",
  "provider:aws:statestore",
  "live",
];

const unredact = (value: string | Redacted.Redacted<string> | undefined) =>
  Redacted.isRedacted(value) ? Redacted.value(value) : value;

/** The stored text of every record and the output of a stage, keyed by sort key. */
const stageTexts = Effect.fn(function* (table: string, bucket: string, stage: string) {
  const items = yield* dynamodb
    .query({
      TableName: table,
      ConsistentRead: true,
      KeyConditionExpression: "PK = :pk",
      ExpressionAttributeValues: { ":pk": { S: `STAGE#${STACK}#${stage}` } },
    })
    .pipe(Effect.map((result) => result.Items ?? []));
  const texts = new Map<string, string>();
  for (const item of items) {
    const sk = item.SK?.S ?? "";
    if (!sk.startsWith("RECORD#") && sk !== "OUTPUT") continue;
    const inline = item.data?.S;
    const ref = item.ref?.S;
    texts.set(
      sk,
      inline ??
        (yield* s3
          .getObject({ Bucket: bucket, Key: ref! })
          .pipe(Effect.flatMap((result) => result.Body!.pipe(Stream.decodeText, Stream.mkString)))),
    );
  }
  return texts;
});

/** The overflow objects a stage's records point at. */
const overflowRefs = Effect.fn(function* (table: string, stage: string) {
  const items = yield* dynamodb
    .query({
      TableName: table,
      ConsistentRead: true,
      KeyConditionExpression: "PK = :pk",
      ExpressionAttributeValues: { ":pk": { S: `STAGE#${STACK}#${stage}` } },
    })
    .pipe(Effect.map((result) => result.Items ?? []));
  return items.flatMap((item) => (item.ref?.S === undefined ? [] : [item.ref.S]));
});

const describeTable = (table: string) =>
  dynamodb.describeTable({ TableName: table }).pipe(
    Effect.map((result) => result.Table),
    Effect.catchTag("ResourceNotFoundException", () => Effect.undefined),
  );

/**
 * Wait until a table is done changing: a move to a new KMS key keeps a
 * table UPDATING for many minutes, and a table can't be deleted until then.
 */
const waitForTableSettled = (table: string) =>
  describeTable(table).pipe(
    Effect.repeat({
      until: (observed) =>
        observed === undefined ||
        (observed.TableStatus === "ACTIVE" && observed.SSEDescription?.Status !== "UPDATING"),
      schedule: Schedule.spaced("15 seconds"),
      times: 120,
    }),
  );

/** Wait until a deleted table is gone. */
const waitForTableGone = (table: string) =>
  describeTable(table).pipe(
    Effect.repeat({
      until: (observed) => observed === undefined,
      schedule: Schedule.spaced("15 seconds"),
      times: 120,
    }),
  );

/** Delete the store, waiting out a table still moving to a key or deleting. */
const teardownStore = Effect.fn(function* (name: string) {
  const table = `alchemy-state-${name}`;
  yield* waitForTableSettled(table);
  const observed = yield* describeTable(table);
  if (observed?.TableStatus !== "DELETING") {
    yield* Alchemist.State.teardown({ type: "provider", backend: "aws", name }).pipe(
      Effect.provide(Alchemist.layer()),
      // A table re-encrypted under a new key takes many minutes to delete.
      Effect.catchIf(
        (error) => error.message.includes("is still deleting"),
        () => Effect.void,
      ),
    );
  }
  yield* waitForTableGone(table);
});

const keyArnOf = (alias: string) =>
  kms.describeKey({ KeyId: alias }).pipe(
    Effect.map((result) => result.KeyMetadata?.Arn),
    Effect.catchTag("NotFoundException", () => Effect.undefined),
  );

/** The KMS key a sealed record of `stage` wrapped its data key with. */
const sealingKeyOf = (text: string, stage: string) =>
  kms
    .decrypt({
      // `alchemy:sealed:1:aws-kms:<wrapped data key>\n<record>`
      CiphertextBlob: Buffer.from(text.split("\n")[0]!.split(":")[4]!, "base64"),
      EncryptionContext: { "alchemy:stack": STACK, "alchemy:stage": stage },
    })
    .pipe(Effect.map((result) => result.KeyId));

test.provider.skipIf(!!process.env.FAST)(
  `a DynamoDB store written by ${RELEASED} moves to KMS and seals its secrets without losing any`,
  (stack) =>
    Effect.gen(function* () {
      const name = storeNameFor("upd", stack.stage);
      const table = `alchemy-state-${name}`;
      const { accountId, region } = yield* AWSEnvironment.current;
      const bucket = createOverflowBucketName(accountId, region, name);
      const alias = `alias/alchemy-state-${name}`;

      yield* teardownStore(name);
      const cwd = yield* workdir(name);
      const old = yield* released();
      const next = yield* current();
      const env = { UPGRADE_STORE: "dynamodb", UPGRADE_STORE_NAME: name };
      const on = (overrides: Record<string, string> = {}): RunOptions => ({
        cwd,
        env: { ...env, ...overrides },
      });

      // The released version creates the store and deploys two stages.
      // `one` has a record too large for an item, kept in the overflow bucket.
      yield* succeeds(old, deployArgs("one"), on({ UPGRADE_LARGE: "true" }));
      yield* succeeds(old, deployArgs("two"), on());
      const before = (yield* describeTable(table))!;
      expect(before.SSEDescription?.SSEType).not.toBe("KMS");
      const one = yield* stageTexts(table, bucket, "one");
      const two = yield* stageTexts(table, bucket, "two");
      expect(one.size).toBe(4); // Secret, Token, Large and the output
      expect(two.size).toBe(3);
      expect(yield* overflowRefs(table, "one")).toHaveLength(1);
      expectPlaintext(one.values());
      const oneSecrets = secretsOfTexts(one.values());
      const twoSecrets = secretsOfTexts(two.values());
      // Each Random twice: in its record and in the stack output (Large isn't an output).
      expect(oneSecrets).toHaveLength(5);

      // In CI, the first run of the new version needs the store bootstrapped:
      // it fails before it changes anything.
      const ciEnv = { ...on().env, ...(yield* awsCiEnv) };
      const ci = yield* fails(next, ["deploy", MAIN, "--stage", "one"], {
        cwd,
        env: ciEnv,
        ci: true,
      });
      expect(ci.output).toContain(`alchemy state bootstrap --backend aws --name ${name}`);
      expect(yield* keyArnOf(alias)).toBeUndefined();
      expect((yield* describeTable(table))?.SSEDescription?.SSEType).not.toBe("KMS");
      expect(yield* stageTexts(table, bucket, "one")).toEqual(one);

      // The command the failure names creates the key and moves the table
      // and bucket to it. CI then deploys, sealing the stage it deploys,
      // with nothing changing in the stack.
      yield* succeeds(next, ["state", "bootstrap", "--backend", "aws", "--name", name], on());
      const upgraded = yield* succeeds(next, ["deploy", MAIN, "--stage", "one"], {
        cwd,
        env: { ...ciEnv, UPGRADE_LARGE: "true" },
        ci: true,
      });
      expect(planLine(upgraded)).toBe("Plan: no changes");
      const keyArn = (yield* keyArnOf(alias))!;
      expect(keyArn).toBeDefined();
      expect((yield* kms.getKeyRotationStatus({ KeyId: keyArn })).KeyRotationEnabled).toBe(true);
      const moving = (yield* describeTable(table))!;
      expect(moving.TableStatus).toBe("ACTIVE");
      // The move runs in the background; DynamoDB names the key once it is done.
      expect(["UPDATING", "ENABLED"]).toContain(moving.SSEDescription?.Status);
      const rule = (yield* s3.getBucketEncryption({ Bucket: bucket }))
        .ServerSideEncryptionConfiguration?.Rules?.[0]?.ApplyServerSideEncryptionByDefault;
      expect(rule?.SSEAlgorithm).toBe("aws:kms");
      expect(unredact(rule?.KMSMasterKeyID)).toBe(keyArn);
      const format = yield* dynamodb.getItem({
        TableName: table,
        Key: { PK: { S: "STORE" }, SK: { S: "FORMAT" } },
        ConsistentRead: true,
      });
      expect(format.Item?.format?.N).toBe("1");

      const sealedOne = yield* stageTexts(table, bucket, "one");
      expect([...sealedOne.keys()].sort()).toEqual([...one.keys()].sort());
      expectSealed(sealedOne.values(), oneSecrets);
      for (const text of sealedOne.values()) expect(yield* sealingKeyOf(text, "one")).toBe(keyArn);
      // The large record is rewritten to a new overflow object, encrypted with the key.
      const [ref] = yield* overflowRefs(table, "one");
      const head = yield* s3.headObject({ Bucket: bucket, Key: ref! });
      expect(head.ServerSideEncryption).toBe("aws:kms");
      expect(unredact(head.SSEKMSKeyId)).toBe(keyArn);
      // A stage nobody has deployed yet is left as the released version wrote it.
      expect(yield* stageTexts(table, bucket, "two")).toEqual(two);

      // The released version can still deploy the stage it can read, and
      // refuses the sealed one without writing to it.
      const stillOld = yield* succeeds(old, deployArgs("two"), on());
      expect(planLine(stillOld)).toBe("Plan: no changes");
      const refused = yield* fails(old, deployArgs("one"), on({ UPGRADE_LARGE: "true" }));
      expect(refused.output).toContain("Failed to parse");
      expect(yield* stageTexts(table, bucket, "one")).toEqual(sealedOne);

      // The new version seals `two` when it deploys it.
      yield* succeeds(next, deployArgs("two"), on());
      expectSealed((yield* stageTexts(table, bucket, "two")).values(), twoSecrets);

      // The new version reads back every secret the released one wrote.
      const store = makeDynamoDBState({ name });
      expect(yield* secretsThroughStore(store, "one")).toEqual(oneSecrets);
      expect(yield* secretsThroughStore(store, "two")).toEqual(twoSecrets);

      // Downgrading: with the layer's `disable`, each deploy decrypts its
      // stage, and the released version deploys it again unchanged.
      for (const [stage, secrets, extra] of [
        ["one", oneSecrets, { UPGRADE_LARGE: "true" }],
        ["two", twoSecrets, {}],
      ] as const) {
        yield* succeeds(
          next,
          deployArgs(stage),
          on({ ...extra, UPGRADE_ENCRYPTION: "kms-disable" }),
        );
        const decrypted = yield* stageTexts(table, bucket, stage);
        expectPlaintext(decrypted.values());
        expect(secretsOfTexts(decrypted.values())).toEqual(secrets);
        const downgraded = yield* succeeds(old, deployArgs(stage), on(extra));
        expect(planLine(downgraded)).toBe("Plan: no changes");
        expect(secretsOfTexts((yield* stageTexts(table, bucket, stage)).values())).toEqual(secrets);
      }

      yield* teardownStore(name);
      expect(yield* keyArnOf(alias)).toBeUndefined();
    }),
  // The table's move to the key, and its delete after, each take minutes.
  { tags, timeout: 3_600_000 },
);

test.provider(
  `a DynamoDB store ${RELEASED} created with a customer kmsKeyId keeps that key`,
  (stack) =>
    Effect.gen(function* () {
      const name = storeNameFor("upk", stack.stage);
      const table = `alchemy-state-${name}`;
      const { accountId, region } = yield* AWSEnvironment.current;
      const bucket = createOverflowBucketName(accountId, region, name);

      yield* stack.destroy();
      yield* teardownStore(name);
      const key = yield* stack.deploy(
        AWS.KMS.Key("CustomerKey", {
          description: "State upgrade test: a customer key",
          deletionWindow: "7 days",
        }),
      );
      const cwd = yield* workdir(name);
      const old = yield* released();
      const next = yield* current();
      const env = { UPGRADE_STORE: "dynamodb", UPGRADE_STORE_NAME: name };
      const on = (overrides: Record<string, string> = {}): RunOptions => ({
        cwd,
        env: { ...env, ...overrides },
      });

      // The released version creates the table under the customer key.
      yield* succeeds(old, deployArgs("one"), on({ UPGRADE_KMS_KEY: key.keyArn }));
      expect((yield* describeTable(table))?.SSEDescription?.KMSMasterKeyArn).toBe(key.keyArn);
      const secrets = secretsOfTexts((yield* stageTexts(table, bucket, "one")).values());

      // The option is gone; deploying without a layer keeps the table on
      // the customer key, seals with it, and creates no key of its own.
      const upgraded = yield* succeeds(next, deployArgs("one"), on());
      expect(planLine(upgraded)).toBe("Plan: no changes");
      expect(upgraded.output).not.toContain("encrypting table");
      const observed = (yield* describeTable(table))!;
      expect(observed.SSEDescription?.KMSMasterKeyArn).toBe(key.keyArn);
      expect(observed.SSEDescription?.Status).toBe("ENABLED");
      expect(yield* keyArnOf(`alias/alchemy-state-${name}`)).toBeUndefined();
      const sealed = yield* stageTexts(table, bucket, "one");
      expectSealed(sealed.values(), secrets);
      for (const text of sealed.values()) {
        expect(yield* sealingKeyOf(text, "one")).toBe(key.keyArn);
      }

      // Naming the key in the layer is the same store.
      const layered = yield* succeeds(
        next,
        deployArgs("one"),
        on({ UPGRADE_ENCRYPTION: "kms", UPGRADE_KMS_KEY: key.keyArn }),
      );
      expect(planLine(layered)).toBe("Plan: no changes");
      expect(yield* secretsThroughStore(makeDynamoDBState({ name }), "one")).toEqual(secrets);

      yield* teardownStore(name);
      yield* stack.destroy();
    }),
  { tags, timeout: 600_000 },
);
