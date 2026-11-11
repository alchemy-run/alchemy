import * as AWS from "@alchemy.run/aws";
import { makeDynamoDBState } from "@alchemy.run/aws";
import { AWSEnvironment } from "@alchemy.run/aws/Environment";
import { createStateBucketName } from "@alchemy.run/aws/StateStore/State";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as dynamodb from "@distilled.cloud/aws/dynamodb";
import * as s3 from "@distilled.cloud/aws/s3";
import * as Alchemist from "alchemy/Alchemist";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
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
  "provider:aws:s3",
  "provider:aws:dynamodb",
  "provider:aws:kms",
  "provider:aws:statestore",
  "live",
];

/** A stage's state objects in the S3 store, by object key. */
const s3Texts = Effect.fn(function* (bucket: string, stage: string) {
  const listed = yield* s3.listObjectsV2({ Bucket: bucket, Prefix: `${STACK}/${stage}/` });
  const texts = new Map<string, string>();
  for (const { Key } of listed.Contents ?? []) {
    if (Key === undefined || Key.endsWith("__lease__.json")) continue;
    const object = yield* s3.getObject({ Bucket: bucket, Key });
    texts.set(Key, yield* object.Body!.pipe(Stream.decodeText, Stream.mkString));
  }
  return texts;
});

/** A stage's records and output in the DynamoDB store, inline ones only. */
const tableTexts = Effect.fn(function* (table: string, stage: string) {
  const result = yield* dynamodb.query({
    TableName: table,
    ConsistentRead: true,
    KeyConditionExpression: "PK = :pk",
    ExpressionAttributeValues: { ":pk": { S: `STAGE#${STACK}#${stage}` } },
  });
  const texts = new Map<string, string>();
  for (const item of result.Items ?? []) {
    const sk = item.SK?.S ?? "";
    if ((sk.startsWith("RECORD#") || sk === "OUTPUT") && item.data?.S !== undefined) {
      texts.set(sk, item.data.S);
    }
  }
  return texts;
});

const teardownStores = (name: string) =>
  Effect.forEach(["aws", "aws-s3"] as const, (backend) =>
    Alchemist.State.teardown({ type: "provider", backend, name }),
  ).pipe(Effect.provide(Alchemist.layer()));

test.provider(
  `stages ${RELEASED} kept in S3 migrate to DynamoDB sealed, and roll back readable`,
  (stack) =>
    Effect.gen(function* () {
      const name = storeNameFor("upm", stack.stage);
      const table = `alchemy-state-${name}`;
      const { accountId, region } = yield* AWSEnvironment.current;
      const bucket = createStateBucketName(accountId, region, name);

      yield* teardownStores(name);
      const cwd = yield* workdir(name);
      const old = yield* released();
      const next = yield* current();
      const on = (store: "s3" | "dynamodb"): RunOptions => ({
        cwd,
        env: { UPGRADE_STORE: store, UPGRADE_STORE_NAME: name },
      });

      // A project on the released version that kept its state in S3.
      yield* succeeds(old, deployArgs("one"), on("s3"));
      const original = yield* s3Texts(bucket, "one");
      expect(original.size).toBe(3);
      const secrets = secretsOfTexts(original.values());

      // The new version's DynamoDB store refuses the stage until it moves.
      const refused = yield* fails(next, deployArgs("one"), on("dynamodb"));
      expect(refused.output).toContain("alchemy state migrate");

      const migrated = yield* succeeds(
        next,
        ["state", "migrate", "--config", MAIN, "--stage", "one"],
        on("dynamodb"),
      );
      // Two records; the stack output moves with them.
      expect(migrated.output).toContain(`${STACK}/one: migrated (2 records)`);
      const moved = yield* tableTexts(table, "one");
      expect(moved.size).toBe(3);
      expectSealed(moved.values(), secrets);

      // Deploying from DynamoDB changes nothing.
      const deployed = yield* succeeds(next, deployArgs("one"), on("dynamodb"));
      expect(planLine(deployed)).toBe("Plan: no changes");
      expect(yield* secretsThroughStore(makeDynamoDBState({ name }), "one")).toEqual(secrets);

      // The released version can use neither copy: the S3 objects are closed
      // to it, and the DynamoDB records are sealed. It writes to neither.
      const sealed = yield* tableTexts(table, "one");
      yield* fails(old, deployArgs("one"), on("s3"));
      yield* fails(old, deployArgs("one"), on("dynamodb"));
      expect(yield* tableTexts(table, "one")).toEqual(sealed);

      // Rolling back writes the stage to S3 decrypted, for the released version.
      const rolledBack = yield* succeeds(
        next,
        ["state", "migrate", "--config", MAIN, "--stage", "one", "--rollback"],
        on("dynamodb"),
      );
      expect(rolledBack.output).toContain("Rolled back the state store");
      const restored = yield* s3Texts(bucket, "one");
      expect([...restored.keys()].sort()).toEqual([...original.keys()].sort());
      expectPlaintext(restored.values());
      expect(secretsOfTexts(restored.values())).toEqual(secrets);

      const downgraded = yield* succeeds(old, deployArgs("one"), on("s3"));
      expect(planLine(downgraded)).toBe("Plan: no changes");

      yield* teardownStores(name);
    }),
  { tags, timeout: 600_000 },
);

test.provider(
  `a stage of ${RELEASED} the new version sealed in S3 migrates to DynamoDB still sealed`,
  (stack) =>
    Effect.gen(function* () {
      const name = storeNameFor("ups", stack.stage);
      const table = `alchemy-state-${name}`;
      const { accountId, region } = yield* AWSEnvironment.current;
      const bucket = createStateBucketName(accountId, region, name);

      yield* teardownStores(name);
      const cwd = yield* workdir(name);
      const old = yield* released();
      const next = yield* current();
      const on = (
        store: "s3" | "dynamodb",
        overrides: Record<string, string> = {},
      ): RunOptions => ({
        cwd,
        env: { UPGRADE_STORE: store, UPGRADE_STORE_NAME: name, ...overrides },
      });
      const migrate = ["state", "migrate", "--config", MAIN, "--stage", "one"];

      // A project that upgraded alchemy and stayed on the S3 store: its
      // stage is sealed there under the store's own key.
      yield* succeeds(old, deployArgs("one"), on("s3"));
      const secrets = secretsOfTexts((yield* s3Texts(bucket, "one")).values());
      yield* succeeds(next, deployArgs("one"), on("s3"));
      const sealed = yield* s3Texts(bucket, "one");
      expect(sealed.size).toBe(3);
      expectSealed(sealed.values(), secrets);

      // A DynamoDB store that encrypts another way can't open the stage. It
      // moves none of it, and leaves it to the S3 store.
      const mismatched = yield* fails(
        next,
        migrate,
        on("dynamodb", {
          UPGRADE_ENCRYPTION: "passphrase",
          ALCHEMY_STATE_PASSPHRASE: "state upgrade test passphrase",
        }),
      );
      expect(mismatched.output).toContain(`${STACK}/one: failed`);
      expect(mismatched.output).toContain("encrypted with 'aws-kms'");
      expect((yield* tableTexts(table, "one")).size).toBe(0);
      expect(yield* s3Texts(bucket, "one")).toEqual(sealed);
      const unfenced = yield* succeeds(next, deployArgs("one"), on("s3"));
      expect(planLine(unfenced)).toBe("Plan: no changes");
      expectSealed((yield* s3Texts(bucket, "one")).values(), secrets);

      // The DynamoDB store of the same name shares the key, and takes the
      // records as they are.
      const migrated = yield* succeeds(next, migrate, on("dynamodb"));
      expect(migrated.output).toContain(`${STACK}/one: migrated (2 records)`);
      const moved = yield* tableTexts(table, "one");
      expect(moved.size).toBe(3);
      expectSealed(moved.values(), secrets);
      const deployed = yield* succeeds(next, deployArgs("one"), on("dynamodb"));
      expect(planLine(deployed)).toBe("Plan: no changes");
      expect(yield* secretsThroughStore(makeDynamoDBState({ name }), "one")).toEqual(secrets);

      // Rolled back, the S3 store reads the stage and seals it again.
      yield* succeeds(next, [...migrate, "--rollback"], on("dynamodb"));
      const restored = yield* s3Texts(bucket, "one");
      expectPlaintext(restored.values());
      expect(secretsOfTexts(restored.values())).toEqual(secrets);
      const back = yield* succeeds(next, deployArgs("one"), on("s3"));
      expect(planLine(back)).toBe("Plan: no changes");
      const resealed = yield* s3Texts(bucket, "one");
      expect([...resealed.keys()].sort()).toEqual([...sealed.keys()].sort());
      expectSealed(resealed.values(), secrets);

      yield* teardownStores(name);
    }),
  { tags, timeout: 600_000 },
);
