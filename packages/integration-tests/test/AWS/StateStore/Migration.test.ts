import { createHash } from "node:crypto";
import * as AWS from "@alchemy.run/aws";
import { makeDynamoDBState, makeS3State } from "@alchemy.run/aws";
import { AWSEnvironment } from "@alchemy.run/aws/Environment";
import { migrateToDynamoDB, rollbackToS3 } from "@alchemy.run/aws/StateStore/Migration";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as dynamodb from "@distilled.cloud/aws/dynamodb";
import * as s3 from "@distilled.cloud/aws/s3";
import * as Alchemy from "alchemy";
import * as Alchemist from "alchemy/Alchemist";
import { StateStoreError, type ResourceState } from "alchemy/State";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Redacted from "effect/Redacted";

const { test, deploy, destroy } = Test.make({ providers: AWS.providers() });

const STACK = "StateMigrationTestStack";

const tags = [
  "provider:aws",
  "provider:aws:dynamodb",
  "provider:aws:s3",
  "provider:aws:statestore",
  "live",
];

/** A DynamoDB store's table and overflow bucket, and an S3 store's bucket. */
const Storage = Effect.gen(function* () {
  const table = yield* AWS.DynamoDB.Table("MigrationTable", {
    partitionKey: "PK",
    sortKey: "SK",
    attributes: { PK: "S", SK: "S" },
  });
  const overflow = yield* AWS.S3.Bucket("MigrationOverflow", { forceDestroy: true });
  const legacy = yield* AWS.S3.Bucket("MigrationLegacy", { forceDestroy: true });
  return {
    tableName: table.tableName,
    overflowBucketName: overflow.bucketName,
    legacyBucketName: legacy.bucketName,
  };
});

interface Storage {
  readonly tableName: string;
  readonly overflowBucketName: string;
  readonly legacyBucketName: string;
}

const PREFIX = "legacy";

const stores = (storage: Storage) => ({
  /** The S3 store, as an older alchemy runs it. */
  s3: makeS3State({ bucketName: storage.legacyBucketName, prefix: PREFIX }),
  dynamodb: makeDynamoDBState({
    tableName: storage.tableName,
    overflowBucketName: storage.overflowBucketName,
    migrateFrom: { bucketName: storage.legacyBucketName, prefix: PREFIX },
  }),
});

const resource = (fqn: string, attr: Record<string, unknown>): ResourceState =>
  ({
    resourceType: "test:resource",
    namespace: undefined,
    fqn,
    logicalId: fqn,
    instanceId: `instance-${fqn}`,
    providerVersion: 1,
    status: "created",
    downstream: [],
    bindings: [],
    props: {},
    attr,
  }) as ResourceState;

const a = resource("Parent/ResourceA", { value: "a" });
const b = resource("ResourceB", { value: "b" });
const output = { url: "https://example.com" };

/** Deploy-like writes through the S3 store, released when done. */
const seedS3 = (storage: Storage, stage: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const state = yield* stores(storage).s3;
      yield* state.set({ stack: STACK, stage, fqn: a.fqn, value: a });
      yield* state.set({ stack: STACK, stage, fqn: b.fqn, value: b });
      yield* state.setOutput({ stack: STACK, stage, value: output });
    }),
  );

const legacyKeys = (storage: Storage, stage: string) =>
  s3
    .listObjectsV2({ Bucket: storage.legacyBucketName, Prefix: `${PREFIX}/${STACK}/${stage}/` })
    .pipe(Effect.map((result) => (result.Contents ?? []).map((object) => object.Key).sort()));

test.provider(
  "a stage still in S3 is refused until it is migrated, then served from DynamoDB",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const storage = yield* stack.deploy(Storage);
      const stage = "refuse-then-migrate";
      yield* seedS3(storage, stage);

      yield* Effect.scoped(
        Effect.gen(function* () {
          const state = yield* stores(storage).dynamodb;
          const refused = yield* state.get({ stack: STACK, stage, fqn: a.fqn }).pipe(Effect.flip);
          expect(refused).toBeInstanceOf(StateStoreError);
          expect(refused.requires?.command).toBe("alchemy state migrate --backend aws");
          // Reads that take no lease still see the S3 copy.
          expect(yield* state.getOutput({ stack: STACK, stage })).toEqual(output);
          expect(yield* state.listStages(STACK)).toContain(stage);
        }),
      );

      const migrated = yield* Effect.scoped(
        Effect.flatMap(stores(storage).dynamodb, (state) => migrateToDynamoDB(state)),
      );
      expect(migrated).toEqual([{ stack: STACK, stage, status: "migrated", records: 2 }]);

      yield* Effect.scoped(
        Effect.gen(function* () {
          const state = yield* stores(storage).dynamodb;
          expect(yield* state.get({ stack: STACK, stage, fqn: a.fqn })).toEqual(a);
          expect([...(yield* state.list({ stack: STACK, stage }))].sort()).toEqual([
            "Parent/ResourceA",
            "ResourceB",
          ]);
          expect(yield* state.getOutput({ stack: STACK, stage })).toEqual(output);
        }),
      );

      // The S3 copy is kept, and fenced: an older alchemy can't take it.
      expect(yield* legacyKeys(storage, stage)).toHaveLength(4);
      const fenced = yield* Effect.scoped(
        Effect.flatMap(stores(storage).s3, (state) =>
          state.set({ stack: STACK, stage, fqn: a.fqn, value: a }),
        ),
      ).pipe(Effect.flip);
      expect(fenced.message).toContain("another deploy holds the S3 state lock");

      // Running it again finds nothing left to move.
      const again = yield* Effect.scoped(
        Effect.flatMap(stores(storage).dynamodb, (state) => migrateToDynamoDB(state)),
      );
      expect(again).toEqual([{ stack: STACK, stage, status: "already-migrated" }]);

      yield* stack.destroy();
    }),
  { tags, timeout: 180_000 },
);

test.provider(
  "a migration that stops after fencing or before committing finishes on the next run",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const storage = yield* stack.deploy(Storage);
      const stage = "interrupted";
      yield* seedS3(storage, stage);

      for (const failAt of ["fenced", "copied"] as const) {
        const interrupted = yield* Effect.scoped(
          Effect.flatMap(stores(storage).dynamodb, (state) =>
            migrateToDynamoDB(state, {
              afterStep: (step) =>
                step === failAt
                  ? Effect.fail(new StateStoreError({ message: `stopped after ${step}` }))
                  : Effect.void,
            }),
          ),
        ).pipe(Effect.flip);
        expect(interrupted.message).toBe(`stopped after ${failAt}`);

        // Not committed: the stage is still refused, and still fenced in S3.
        const refused = yield* Effect.scoped(
          Effect.flatMap(stores(storage).dynamodb, (state) =>
            state.get({ stack: STACK, stage, fqn: a.fqn }),
          ),
        ).pipe(Effect.flip);
        expect(refused.requires?.command).toBe("alchemy state migrate --backend aws");
        const fenced = yield* Effect.scoped(
          Effect.flatMap(stores(storage).s3, (state) => state.list({ stack: STACK, stage })),
        ).pipe(Effect.flip);
        expect(fenced.message).toContain("another deploy holds the S3 state lock");
      }

      const finished = yield* Effect.scoped(
        Effect.flatMap(stores(storage).dynamodb, (state) => migrateToDynamoDB(state)),
      );
      expect(finished).toEqual([{ stack: STACK, stage, status: "migrated", records: 2 }]);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const state = yield* stores(storage).dynamodb;
          expect(yield* state.get({ stack: STACK, stage, fqn: b.fqn })).toEqual(b);
        }),
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 180_000 },
);

test.provider(
  "a stage an S3 deploy holds is reported as blocked and moves once it is released",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const storage = yield* stack.deploy(Storage);
      const stage = "blocked";
      yield* seedS3(storage, stage);

      yield* Effect.scoped(
        Effect.gen(function* () {
          // An older alchemy, mid-deploy.
          const deploying = yield* stores(storage).s3;
          yield* deploying.list({ stack: STACK, stage });
          const result = yield* Effect.scoped(
            Effect.flatMap(stores(storage).dynamodb, (state) => migrateToDynamoDB(state)),
          );
          expect(result).toHaveLength(1);
          expect(result[0]?.status).toBe("blocked");
          // The deploy keeps its lease and can still write.
          yield* deploying.set({
            stack: STACK,
            stage,
            fqn: "ResourceC",
            value: resource("ResourceC", {}),
          });
        }),
      );

      const moved = yield* Effect.scoped(
        Effect.flatMap(stores(storage).dynamodb, (state) => migrateToDynamoDB(state)),
      );
      expect(moved).toEqual([{ stack: STACK, stage, status: "migrated", records: 3 }]);
      yield* stack.destroy();
    }),
  { tags, timeout: 180_000 },
);

test.provider(
  "rollback moves stages, including ones written since, back to the S3 store",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const storage = yield* stack.deploy(Storage);
      const moved = "moved";
      const native = "native";
      yield* seedS3(storage, moved);
      yield* Effect.scoped(
        Effect.flatMap(stores(storage).dynamodb, (state) => migrateToDynamoDB(state)),
      );

      // Writes after the migration, and a stage that started in DynamoDB.
      const c = resource("ResourceC", { value: "c" });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const state = yield* stores(storage).dynamodb;
          yield* state.delete({ stack: STACK, stage: moved, fqn: b.fqn });
          yield* state.set({ stack: STACK, stage: moved, fqn: c.fqn, value: c });
          yield* state.set({ stack: STACK, stage: native, fqn: a.fqn, value: a });
        }),
      );

      const rolledBack = yield* Effect.scoped(
        Effect.flatMap(stores(storage).dynamodb, (state) => rollbackToS3(state)),
      );
      expect([...rolledBack].sort((x, y) => x.stage.localeCompare(y.stage))).toEqual([
        { stack: STACK, stage: moved, status: "rolled-back", records: 2 },
        { stack: STACK, stage: native, status: "rolled-back", records: 1 },
      ]);

      // An older alchemy has its stages back, with the writes it missed.
      yield* Effect.scoped(
        Effect.gen(function* () {
          const state = yield* stores(storage).s3;
          expect([...(yield* state.list({ stack: STACK, stage: moved }))].sort()).toEqual([
            "Parent/ResourceA",
            "ResourceC",
          ]);
          expect(yield* state.get({ stack: STACK, stage: moved, fqn: c.fqn })).toEqual(c);
          expect(yield* state.getOutput({ stack: STACK, stage: moved })).toEqual(output);
          expect(yield* state.get({ stack: STACK, stage: native, fqn: a.fqn })).toEqual(a);
          yield* state.set({ stack: STACK, stage: native, fqn: b.fqn, value: b });
        }),
      );

      // And the DynamoDB store refuses them until they are migrated again.
      const refused = yield* Effect.scoped(
        Effect.flatMap(stores(storage).dynamodb, (state) =>
          state.list({ stack: STACK, stage: native }),
        ),
      ).pipe(Effect.flip);
      expect(refused.requires?.command).toBe("alchemy state migrate --backend aws");
      const items = yield* dynamodb.query({
        TableName: storage.tableName,
        ConsistentRead: true,
        KeyConditionExpression: "PK = :pk",
        ExpressionAttributeValues: { ":pk": { S: `STAGE#${STACK}#${moved}` } },
      });
      expect(items.Items ?? []).toEqual([]);
      yield* stack.destroy();
    }),
  { tags, timeout: 180_000 },
);

test.provider(
  "a Stack deployed on the S3 store redeploys from DynamoDB after `alchemy state migrate`",
  (stack) =>
    Effect.gen(function* () {
      const { accountId, region } = yield* AWSEnvironment.current;
      // A named store per stage, so runs never touch the account's default.
      const name = `mig-${yield* Effect.sync(() =>
        createHash("sha256").update(stack.stage).digest("hex").slice(0, 8),
      )}`;
      const program = Effect.gen(function* () {
        const secret = yield* Alchemy.Random("Secret");
        return { secret: secret.text };
      });
      const OnS3 = Alchemy.Stack(
        "StateMigrationStack",
        { providers: AWS.providers(), state: AWS.state({ backend: "s3", name }) },
        program,
      );
      const OnDynamoDB = Alchemy.Stack(
        "StateMigrationStack",
        { providers: AWS.providers(), state: AWS.state({ name }) },
        program,
      );
      const alchemist = Alchemist.layer();
      const awsStore = { _tag: "Provider", backend: "aws", name } as const;
      const teardown = Effect.all(
        [
          Alchemist.State.teardown(awsStore),
          Alchemist.State.teardown({ _tag: "Provider", backend: "aws-s3", name } as const),
        ],
        { discard: true },
      ).pipe(Effect.provide(alchemist));

      yield* teardown;
      const first = yield* deploy(OnS3);

      // The upgraded config refuses the stage instead of redeploying it fresh.
      const refused = yield* Effect.exit(deploy(OnDynamoDB));
      expect(Exit.isFailure(refused)).toBe(true);
      if (Exit.isFailure(refused)) {
        expect(Cause.pretty(refused.cause)).toContain(
          `alchemy state migrate --backend aws --name ${name}`,
        );
      }

      const result = yield* Alchemist.State.migrate(awsStore).pipe(Effect.provide(alchemist));
      expect(
        result.stages.map(({ stack, status, records }) => ({ stack, status, records })),
      ).toEqual([{ stack: "StateMigrationStack", status: "migrated", records: 1 }]);

      // Same resource, same secret: the state moved rather than starting over.
      const second = yield* deploy(OnDynamoDB);
      expect(Redacted.value(second.secret)).toBe(Redacted.value(first.secret));

      yield* destroy(OnDynamoDB);
      const torn = yield* Alchemist.State.teardown(awsStore).pipe(Effect.provide(alchemist));
      expect(torn.deleted).toEqual(
        expect.arrayContaining([
          `alchemy-state-${name}`,
          `alchemy-state-${name}-${accountId}-${region}-an`,
        ]),
      );
    }),
  { tags, timeout: 300_000 },
);
