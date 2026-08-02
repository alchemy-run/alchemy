import * as kms from "@distilled.cloud/aws/kms";
import * as s3 from "@distilled.cloud/aws/s3";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { adopt } from "../../AdoptPolicy.ts";
import { AlchemyContext } from "../../AlchemyContext.ts";
import { ALCHEMY_PROFILE } from "../../Auth/Profile.ts";
import { deploy } from "../../Deploy.ts";
import * as Alchemy from "../../Stack.ts";
import {
  hasLocalBootstrapStack,
  hoistBootstrapStack,
} from "../../State/Bootstrap.ts";
import { makeLocalState } from "../../State/LocalState.ts";
import {
  State,
  StateStoreError,
  type StateService,
} from "../../State/State.ts";
import * as Clank from "../../Util/Clank.ts";
import { AWSEnvironment } from "../Environment.ts";
import { Alias } from "../KMS/Alias.ts";
import { Key } from "../KMS/Key.ts";
import * as AWSProviders from "../Providers.ts";
import { Bucket } from "../S3/Bucket.ts";
import {
  createStateBucketName,
  makeS3State,
  STATE_KMS_ALIAS,
  stateLayer,
  type S3StateOptions,
} from "./State.ts";

/**
 * The S3 state store's own infrastructure — the state bucket and the KMS
 * secret-encryption key — is deployed as an alchemy stack, mirroring the
 * Cloudflare state store bootstrap: the stack is first deployed against
 * the *local* state store (the bucket does not exist yet), then its
 * state is hoisted into the bucket it just created, and the local copy
 * is deleted. From then on the stack's state lives in the bucket itself
 * and re-running bootstrap converges/upgrades it like any other stack.
 */

/** Name of the stack that manages the state store's own infrastructure. */
export const STATE_STACK_NAME = "AwsStateStore";

const CI = Config.boolean("CI").pipe(Config.withDefault(false));

export interface BootstrapOptions {
  /** @default `alchemy-state-{accountId}-{region}-an` */
  bucketName?: string;
  /** Key prefix within the bucket. @default "" (bucket root) */
  prefix?: string;
  /** @default "alias/alchemy-state" */
  kmsAlias?: `alias/${string}`;
  /** @default false */
  force?: boolean;
}

/**
 * State store backed by an AWS S3 bucket.
 *
 * Stack state is persisted as JSON objects in an account-regional S3
 * bucket, laid out exactly like the local state store's file tree with
 * the bucket (plus optional `prefix`) taking the place of the
 * `.alchemy/state` directory:
 *
 * ```
 * s3://{bucket}/{prefix}{stack}/{stage}/{fqn}.json
 * s3://{bucket}/{prefix}{stack}/{stage}/__stack_output__.json
 * ```
 *
 * The bucket and the KMS secret-encryption key are provisioned by the
 * {@link bootstrap} stack. When they are missing on first use, an
 * interactive run asks for consent and deploys them; CI fails with an
 * actionable message unless `--yes` is passed (which deploys
 * automatically). `alchemy aws bootstrap` provisions them explicitly.
 *
 * @resource
 *
 * @section Using the S3 State Store
 * Pass `AWS.state()` as the `state` option of a Stack. By default the
 * state is stored in an account-regional bucket named
 * `alchemy-state-{accountId}-{region}-an`.
 *
 * @example Default bucket
 * ```typescript
 * import * as Alchemy from "alchemy";
 * import * as AWS from "alchemy/AWS";
 *
 * const Stack = Alchemy.Stack(
 *   "my-stack",
 *   { providers: AWS.providers(), state: AWS.state() },
 *   Effect.gen(function* () {
 *     // ...
 *   }),
 * );
 * ```
 *
 * @example Custom bucket and key prefix
 * ```typescript
 * const Stack = Alchemy.Stack(
 *   "my-stack",
 *   {
 *     providers: AWS.providers(),
 *     state: AWS.state({
 *       bucketName: "my-company-state",
 *       prefix: "alchemy",
 *     }),
 *   },
 *   Effect.gen(function* () {
 *     // ...
 *   }),
 * );
 * ```
 */
export const state = (options: S3StateOptions = {}) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const context =
        yield* Effect.context<
          Effect.Services<ReturnType<typeof consentBootstrap>>
        >();
      return stateLayer({
        ...options,
        onMissingInfra: (which) =>
          consentBootstrap(which, options).pipe(
            Effect.provideContext(context),
            Effect.mapError((cause) =>
              cause instanceof StateStoreError
                ? cause
                : new StateStoreError({
                    message:
                      cause instanceof Error
                        ? cause.message
                        : `AWS state store bootstrap failed: ${String(cause)}`,
                    cause: cause instanceof Error ? cause : undefined,
                  }),
            ),
          ),
      });
    }),
  );

/**
 * The consent flow behind `AWS.state()` when state infrastructure is
 * missing: deploy automatically under `--yes` (AlchemyContext
 * `updateStateStore`), fail with an actionable message in CI, and ask
 * in an interactive terminal.
 */
const consentBootstrap = (which: "bucket" | "kms", options: S3StateOptions) =>
  Effect.gen(function* () {
    const isCI = yield* CI;
    const auto =
      Option.getOrUndefined(yield* Effect.serviceOption(AlchemyContext))
        ?.updateStateStore ?? false;
    const run = bootstrap({
      bucketName: options.bucketName,
      prefix: options.prefix,
      kmsAlias: options.kmsAlias,
    }).pipe(Effect.asVoid);
    if (auto) {
      return yield* run;
    }
    if (isCI) {
      return yield* Effect.fail(
        new StateStoreError({
          message:
            which === "bucket"
              ? `AWS S3 state store not found. Run 'alchemy aws bootstrap --profile <your-ci-profile>' to deploy it first, or pass --yes.`
              : `The alchemy state secret-encryption key ('${options.kmsAlias ?? STATE_KMS_ALIAS}') was not found. ` +
                `Run 'alchemy aws bootstrap --profile <your-ci-profile>' to create it, pass --yes, ` +
                `or opt out of KMS with ALCHEMY_PASSWORD or secretEncryption: "off".`,
        }),
      );
    }
    const message =
      which === "bucket"
        ? "AWS S3 state store not found. Deploy it (S3 state bucket + KMS secret-encryption key)?"
        : "Alchemy encrypts secrets in state with a managed KMS key (~$1/month). Create it?";
    const ok = yield* Clank.confirm({ message }).pipe(
      Effect.catchTag("PromptCancelled", () => Effect.succeed(false)),
    );
    if (!ok) {
      return yield* Effect.die(new Clank.PromptCancelled());
    }
    return yield* run;
  });

/**
 * Deploy (or converge) the AWS state store infrastructure: the
 * account-regional state bucket (versioned, SSE, public access blocked,
 * ACLs disabled) and the KMS key + alias that wrap state data keys.
 *
 * The first run deploys the stack against the local state store, hoists
 * the stack's state into the bucket it just created, and deletes the
 * local copy — an interrupted run resumes from the local stack. Later
 * runs find the stack's state in the bucket and converge in place.
 * Existing imperatively-created buckets and aliases are adopted.
 */
export const bootstrap = (options: BootstrapOptions = {}) =>
  Effect.gen(function* () {
    const { accountId, region } = yield* AWSEnvironment.current;
    const profileName = yield* ALCHEMY_PROFILE;
    const bucketName =
      options.bucketName ?? createStateBucketName(accountId, region);
    const kmsAlias = options.kmsAlias ?? STATE_KMS_ALIAS;
    // Key off profile + bucket so concurrent bootstraps of different
    // stores (or profiles) never collide in the local state tree.
    const localStage = `${profileName}_${bucketName}`;
    const remoteStage = region;
    const s3StateOptions: S3StateOptions = {
      bucketName,
      prefix: options.prefix,
      kmsAlias,
    };

    const finishWithLocalState = Effect.gen(function* () {
      const localState = yield* makeLocalState();
      yield* deployStateStack({
        stage: localStage,
        state: localState,
        force: options.force,
        bucketName,
        kmsAlias,
      });
      const s3State = yield* makeS3State(s3StateOptions);
      yield* hoistBootstrapStack({
        stack: STATE_STACK_NAME,
        source: { state: localState, stage: localStage },
        destination: { state: s3State, stage: remoteStage },
      });
      yield* localState.deleteStack({
        stack: STATE_STACK_NAME,
        stage: localStage,
      });
    });

    if (yield* hasLocalBootstrapStack(STATE_STACK_NAME, localStage)) {
      // An interrupted bootstrap left the stack in the local store —
      // finish the deploy and the hoist.
      yield* finishWithLocalState;
    } else {
      const bucketExists = yield* s3.headBucket({ Bucket: bucketName }).pipe(
        Effect.map(() => true),
        Effect.catchTag(["NotFound", "NoSuchBucket"], () =>
          Effect.succeed(false),
        ),
      );
      const alreadyManaged =
        bucketExists &&
        (yield* Effect.flatMap(makeS3State(s3StateOptions), (s3State) =>
          s3State.listStages(STATE_STACK_NAME),
        )).includes(remoteStage);
      if (alreadyManaged) {
        // The stack's state lives in the bucket — a regular converge.
        const s3State = yield* makeS3State(s3StateOptions);
        yield* deployStateStack({
          stage: remoteStage,
          state: s3State,
          force: options.force,
          bucketName,
          kmsAlias,
        });
      } else {
        yield* finishWithLocalState;
      }
    }

    yield* Clank.success(`AWS state store '${bucketName}' is ready.`);
    return { bucketName, kmsAlias, region, accountId };
  }).pipe(
    Effect.withSpan("state_store.bootstrap", {
      attributes: { "alchemy.state_store.op": "bootstrap" },
    }),
  );

/** Deploy the state-store stack against the given state service. */
const deployStateStack = ({
  stage,
  state,
  force,
  bucketName,
  kmsAlias,
}: {
  stage: string;
  state: StateService;
  force?: boolean;
  bucketName: string;
  kmsAlias: `alias/${string}`;
}) =>
  Effect.gen(function* () {
    const stateLayer = Layer.succeed(State, Effect.succeed(state));
    yield* deploy({
      stage,
      force,
      stack: Alchemy.Stack(
        STATE_STACK_NAME,
        { providers: AWSProviders.providers(), state: stateLayer },
        Effect.gen(function* () {
          const key = yield* Key("StateKey", {
            description: "Alchemy state store secret encryption key",
          });
          const alias = yield* Alias("StateAlias", {
            aliasName: kmsAlias,
            targetKeyId: key.keyId,
          });
          const bucket = yield* Bucket("StateBucket", {
            bucketName,
            bucketNamespace: "account-regional",
            versioning: "Enabled",
            encryption: { sseAlgorithm: "AES256" },
            publicAccessBlock: {
              blockPublicAcls: true,
              ignorePublicAcls: true,
              blockPublicPolicy: true,
              restrictPublicBuckets: true,
            },
            objectOwnership: "BucketOwnerEnforced",
          });
          return {
            bucketName: bucket.bucketName.as<string>(),
            keyArn: key.keyArn.as<string>(),
            aliasName: alias.aliasName.as<string>(),
          };
        }),
      ),
    }).pipe(
      // The state store is account-level infrastructure that outlives
      // any single deploy: the bucket and alias may already exist from
      // the imperative auto-create path or a previous (possibly
      // partially-failed) bootstrap. Opt in to adoption so they
      // reconcile in place instead of failing on conflict.
      adopt(true),
      Effect.provide(stateLayer),
    );
  }).pipe(
    Effect.withSpan("state_store.deploy", {
      attributes: { "alchemy.state_store.op": "deploy" },
    }),
  );

export interface TeardownOptions {
  /** @default `alchemy-state-{accountId}-{region}-an` */
  bucketName?: string;
  /** Key prefix within the bucket. @default "" (bucket root) */
  prefix?: string;
  /** @default "alias/alchemy-state" */
  kmsAlias?: `alias/${string}`;
  /**
   * Proceed even when the bucket still holds state for other stacks —
   * their state is destroyed with the bucket.
   * @default false
   */
  force?: boolean;
}

/**
 * The inverse of {@link bootstrap}: tear down the AWS state store.
 * Empties and deletes the state bucket (refusing when it still holds
 * state for other stacks, unless `force`), deletes the KMS alias, and
 * schedules the key for deletion with a 7-day recovery window —
 * re-running {@link bootstrap} within that window recovers the key;
 * afterwards any state secrets encrypted under it are permanently
 * unreadable.
 *
 * Idempotent — missing resources are treated as already-gone.
 */
export const teardown = (options: TeardownOptions = {}) =>
  Effect.gen(function* () {
    const { accountId, region } = yield* AWSEnvironment.current;
    const profileName = yield* ALCHEMY_PROFILE;
    const bucketName =
      options.bucketName ?? createStateBucketName(accountId, region);
    const kmsAlias = options.kmsAlias ?? STATE_KMS_ALIAS;

    const bucketExists = yield* s3.headBucket({ Bucket: bucketName }).pipe(
      Effect.map(() => true),
      Effect.catchTag(["NotFound", "NoSuchBucket"], () =>
        Effect.succeed(false),
      ),
    );
    if (bucketExists) {
      const s3State = yield* makeS3State({
        bucketName,
        prefix: options.prefix,
        kmsAlias,
        // Teardown must never mint infrastructure while destroying it.
        secretEncryption: "off",
      });
      const foreign = (yield* s3State.listStacks()).filter(
        (stack) => stack !== STATE_STACK_NAME,
      );
      if (foreign.length > 0 && !options.force) {
        return yield* Effect.fail(
          new StateStoreError({
            message:
              `State bucket '${bucketName}' still holds state for other stack(s): ${foreign.join(", ")}. ` +
              `Destroying it makes their state unrecoverable — pass force to proceed.`,
          }),
        );
      }
      yield* Clank.info(
        `Emptying and deleting state bucket '${bucketName}'...`,
      );
      yield* emptyBucket(bucketName);
      yield* s3
        .deleteBucket({ Bucket: bucketName })
        .pipe(Effect.catchTag("NoSuchBucket", () => Effect.void));
    }

    const target = yield* kms.describeKey({ KeyId: kmsAlias }).pipe(
      Effect.map((r) => r.KeyMetadata),
      Effect.catchTag("NotFoundException", () => Effect.succeed(undefined)),
    );
    if (target?.KeyId !== undefined) {
      yield* Clank.info(`Deleting KMS alias '${kmsAlias}'...`);
      yield* kms
        .deleteAlias({ AliasName: kmsAlias })
        .pipe(Effect.catchTag("NotFoundException", () => Effect.void));
      if (target.KeyState !== "PendingDeletion") {
        yield* kms
          .scheduleKeyDeletion({
            KeyId: target.KeyId,
            PendingWindowInDays: 7,
          })
          .pipe(
            Effect.catchTag(
              ["KMSInvalidStateException", "NotFoundException"],
              () => Effect.void,
            ),
          );
        yield* Clank.info(
          `Scheduled KMS key ${target.KeyId} for deletion in 7 days. ` +
            `Re-running 'alchemy aws bootstrap' within that window recovers it; ` +
            `afterwards any state secrets encrypted under it are permanently unreadable.`,
        );
      }
    }

    // Drop any stranded local bootstrap stack for this store.
    const localState = yield* makeLocalState();
    yield* localState
      .deleteStack({
        stack: STATE_STACK_NAME,
        stage: `${profileName}_${bucketName}`,
      })
      .pipe(Effect.ignore);

    yield* Clank.success(`AWS state store '${bucketName}' torn down.`);
  }).pipe(
    Effect.withSpan("state_store.teardown", {
      attributes: { "alchemy.state_store.op": "teardown" },
    }),
  );

/**
 * Delete every object version, delete marker, and in-progress multipart
 * upload so `DeleteBucket` succeeds on the versioned state bucket.
 */
const emptyBucket = Effect.fn(function* (bucketName: string) {
  let isTruncated = true;
  let keyMarker: string | undefined;
  let versionIdMarker: string | undefined;
  while (isTruncated) {
    const page = yield* s3.listObjectVersions({
      Bucket: bucketName,
      KeyMarker: keyMarker,
      VersionIdMarker: versionIdMarker,
    });
    const objects = [
      ...(page.Versions ?? []).map((v) => ({
        Key: v.Key!,
        VersionId: v.VersionId,
      })),
      ...(page.DeleteMarkers ?? []).map((dm) => ({
        Key: dm.Key!,
        VersionId: dm.VersionId,
      })),
    ];
    if (objects.length > 0) {
      yield* s3.deleteObjects({
        Bucket: bucketName,
        Delete: { Objects: objects, Quiet: true },
      });
    }
    isTruncated = page.IsTruncated === true;
    keyMarker = page.NextKeyMarker;
    versionIdMarker = page.NextVersionIdMarker;
  }
  let uploadsTruncated = true;
  let uploadKeyMarker: string | undefined;
  let uploadIdMarker: string | undefined;
  while (uploadsTruncated) {
    const uploads = yield* s3.listMultipartUploads({
      Bucket: bucketName,
      KeyMarker: uploadKeyMarker,
      UploadIdMarker: uploadIdMarker,
    });
    const inProgress = (uploads.Uploads ?? []).filter(
      (u) => u.Key != null && u.UploadId != null,
    );
    if (inProgress.length > 0) {
      yield* Effect.all(
        inProgress.map((u) =>
          s3.abortMultipartUpload({
            Bucket: bucketName,
            Key: u.Key!,
            UploadId: u.UploadId!,
          }),
        ),
      );
    }
    uploadsTruncated = uploads.IsTruncated === true;
    uploadKeyMarker = uploads.NextKeyMarker;
    uploadIdMarker = uploads.NextUploadIdMarker;
  }
});
