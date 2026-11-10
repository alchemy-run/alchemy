import * as AWS from "@alchemy.run/aws";
import { AWSEnvironment } from "@alchemy.run/aws/Environment";
import { makeS3State } from "@alchemy.run/aws/StateStore/State";
import { createStateBucketName } from "@alchemy.run/aws/StateStore/State";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as kms from "@distilled.cloud/aws/kms";
import * as s3 from "@distilled.cloud/aws/s3";
import * as Alchemist from "alchemy/Alchemist";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
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
  "provider:aws:s3",
  "provider:aws:kms",
  "provider:aws:statestore",
  "live",
];

const unredact = (value: string | Redacted.Redacted<string> | undefined) =>
  Redacted.isRedacted(value) ? Redacted.value(value) : value;

interface StoredObject {
  readonly text: string;
  readonly etag: string | undefined;
  readonly sse: string | undefined;
  readonly kmsKeyId: string | undefined;
}

/** A stage's state objects, keyed by object key, with how each is encrypted at rest. */
const stageObjects = Effect.fn(function* (bucket: string, stage: string) {
  const listed = yield* s3.listObjectsV2({ Bucket: bucket, Prefix: `${STACK}/${stage}/` });
  const objects = new Map<string, StoredObject>();
  for (const { Key } of listed.Contents ?? []) {
    if (Key === undefined || Key.endsWith("__lease__.json")) continue;
    const object = yield* s3.getObject({ Bucket: bucket, Key });
    objects.set(Key, {
      text: yield* object.Body!.pipe(Stream.decodeText, Stream.mkString),
      etag: object.ETag,
      sse: object.ServerSideEncryption,
      kmsKeyId: unredact(object.SSEKMSKeyId),
    });
  }
  return objects;
});

const texts = (objects: Map<string, StoredObject>) => [...objects.values()].map((o) => o.text);

const bucketDefault = (bucket: string) =>
  s3
    .getBucketEncryption({ Bucket: bucket })
    .pipe(
      Effect.map(
        (result) =>
          result.ServerSideEncryptionConfiguration?.Rules?.[0]?.ApplyServerSideEncryptionByDefault,
      ),
    );

const keyArnOf = (alias: string) =>
  kms.describeKey({ KeyId: alias }).pipe(
    Effect.map((result) => result.KeyMetadata?.Arn),
    Effect.catchTag("NotFoundException", () => Effect.undefined),
  );

const teardownStore = (name: string) =>
  Alchemist.State.teardown({ type: "provider", backend: "aws-s3", name }).pipe(
    Effect.provide(Alchemist.layer()),
  );

test.provider(
  `an S3 store written by ${RELEASED} moves to KMS and seals its secrets without losing any`,
  (stack) =>
    Effect.gen(function* () {
      const name = storeNameFor("ups", stack.stage);
      const { accountId, region } = yield* AWSEnvironment.current;
      const bucket = createStateBucketName(accountId, region, name);
      const alias = `alias/alchemy-state-${name}`;

      yield* teardownStore(name);
      const cwd = yield* workdir(name);
      const old = yield* released();
      const next = yield* current();
      const on = (overrides: Record<string, string> = {}): RunOptions => ({
        cwd,
        env: { UPGRADE_STORE: "s3", UPGRADE_STORE_NAME: name, ...overrides },
      });

      // The released version creates the bucket and deploys two stages.
      yield* succeeds(old, deployArgs("one"), on({ UPGRADE_LARGE: "true" }));
      yield* succeeds(old, deployArgs("two"), on());
      expect((yield* bucketDefault(bucket))?.SSEAlgorithm).toBe("AES256");
      const one = yield* stageObjects(bucket, "one");
      const two = yield* stageObjects(bucket, "two");
      expect(one.size).toBe(4); // Secret, Token, Large and the output
      expect(two.size).toBe(3);
      expectPlaintext(texts(one));
      const oneSecrets = secretsOfTexts(texts(one));
      const twoSecrets = secretsOfTexts(texts(two));
      expect(oneSecrets).toHaveLength(5);

      // In CI, the first run of the new version needs the store bootstrapped.
      const ciEnv = { ...on().env, ...(yield* awsCiEnv) };
      const ci = yield* fails(next, ["deploy", MAIN, "--stage", "one"], {
        cwd,
        env: ciEnv,
        ci: true,
      });
      expect(ci.output).toContain(`alchemy state bootstrap --backend aws-s3 --name ${name}`);
      expect(yield* keyArnOf(alias)).toBeUndefined();
      expect((yield* bucketDefault(bucket))?.SSEAlgorithm).toBe("AES256");
      expect(yield* stageObjects(bucket, "one")).toEqual(one);

      // The first run outside CI creates the key, makes it the bucket's
      // default, and rewrites the stage it deploys sealed, under the key.
      const upgraded = yield* succeeds(next, deployArgs("one"), on({ UPGRADE_LARGE: "true" }));
      expect(planLine(upgraded)).toBe("Plan: no changes");
      const keyArn = (yield* keyArnOf(alias))!;
      expect(keyArn).toBeDefined();
      const rule = yield* bucketDefault(bucket);
      expect(rule?.SSEAlgorithm).toBe("aws:kms");
      expect(unredact(rule?.KMSMasterKeyID)).toBe(keyArn);
      const format = yield* s3.getObject({ Bucket: bucket, Key: "__alchemy_store__.json" });
      expect(JSON.parse(yield* format.Body!.pipe(Stream.decodeText, Stream.mkString))).toEqual({
        format: 1,
      });
      const sealedOne = yield* stageObjects(bucket, "one");
      expect([...sealedOne.keys()].sort()).toEqual([...one.keys()].sort());
      expectSealed(texts(sealedOne), oneSecrets);
      for (const object of sealedOne.values()) {
        expect(object.sse).toBe("aws:kms");
        expect(object.kmsKeyId).toBe(keyArn);
      }
      // A stage nobody has deployed yet is left as the released version wrote it.
      expect(yield* stageObjects(bucket, "two")).toEqual(two);

      // The released version still deploys the stage it can read, and
      // refuses the sealed one without writing to it.
      const stillOld = yield* succeeds(old, deployArgs("two"), on());
      expect(planLine(stillOld)).toBe("Plan: no changes");
      yield* fails(old, deployArgs("one"), on({ UPGRADE_LARGE: "true" }));
      expect(yield* stageObjects(bucket, "one")).toEqual(sealedOne);

      // The new version seals `two` when it deploys it, and puts the key
      // back as the default the released version reset to AES256.
      yield* succeeds(next, deployArgs("two"), on());
      expectSealed(texts(yield* stageObjects(bucket, "two")), twoSecrets);
      expect(unredact((yield* bucketDefault(bucket))?.KMSMasterKeyID)).toBe(keyArn);

      // The new version reads back every secret the released one wrote.
      const store = makeS3State({ name });
      expect(yield* secretsThroughStore(store, "one")).toEqual(oneSecrets);
      expect(yield* secretsThroughStore(store, "two")).toEqual(twoSecrets);

      // Downgrading: `disable` decrypts each stage as it deploys, and the
      // released version deploys it again unchanged.
      for (const [stage, secrets, extra] of [
        ["one", oneSecrets, { UPGRADE_LARGE: "true" }],
        ["two", twoSecrets, {}],
      ] as const) {
        yield* succeeds(
          next,
          deployArgs(stage),
          on({ ...extra, UPGRADE_ENCRYPTION: "kms-disable" }),
        );
        const decrypted = yield* stageObjects(bucket, stage);
        expectPlaintext(texts(decrypted));
        expect(secretsOfTexts(texts(decrypted))).toEqual(secrets);
        const downgraded = yield* succeeds(old, deployArgs(stage), on(extra));
        expect(planLine(downgraded)).toBe("Plan: no changes");
        expect(secretsOfTexts(texts(yield* stageObjects(bucket, stage)))).toEqual(secrets);
      }

      yield* teardownStore(name);
      expect(yield* keyArnOf(alias)).toBeUndefined();
    }),
  { tags, timeout: 600_000 },
);

test.provider(
  `an S3 store ${RELEASED} encrypted with a customer key seals with that key`,
  (stack) =>
    Effect.gen(function* () {
      const name = storeNameFor("usk", stack.stage);
      const { accountId, region } = yield* AWSEnvironment.current;
      const bucket = createStateBucketName(accountId, region, name);

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
      // The bucket's `encryption` names the key, in both versions.
      const on = (overrides: Record<string, string> = {}): RunOptions => ({
        cwd,
        env: {
          UPGRADE_STORE: "s3",
          UPGRADE_STORE_NAME: name,
          UPGRADE_KMS_KEY: key.keyArn,
          ...overrides,
        },
      });

      yield* succeeds(old, deployArgs("one"), on());
      const secrets = secretsOfTexts(texts(yield* stageObjects(bucket, "one")));

      const upgraded = yield* succeeds(next, deployArgs("one"), on());
      expect(planLine(upgraded)).toBe("Plan: no changes");
      expect(yield* keyArnOf(`alias/alchemy-state-${name}`)).toBeUndefined();
      const sealed = yield* stageObjects(bucket, "one");
      expectSealed(texts(sealed), secrets);
      for (const object of sealed.values()) {
        const wrapped = object.text.split("\n")[0]!.split(":")[4]!;
        const opened = yield* kms.decrypt({
          CiphertextBlob: Buffer.from(wrapped, "base64"),
          EncryptionContext: { "alchemy:stack": STACK, "alchemy:stage": "one" },
        });
        expect(opened.KeyId).toBe(key.keyArn);
        expect(object.kmsKeyId).toBe(key.keyArn);
      }
      const store = makeS3State({
        name,
        encryption: { sseAlgorithm: "aws:kms", kmsMasterKeyId: key.keyArn },
      });
      expect(yield* secretsThroughStore(store, "one")).toEqual(secrets);

      yield* teardownStore(name);
      yield* stack.destroy();
    }),
  { tags, timeout: 600_000 },
);
