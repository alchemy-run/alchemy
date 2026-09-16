import {
  encodeS3BucketAlias,
  R2_FUSE_MARKER_ENV,
  S3_GATEWAY_URL_ENV,
} from "@alchemy.run/cloudflare-runtime/core/S3GatewayProtocol";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { AlchemyContext } from "../../AlchemyContext.ts";
import {
  MountError,
  type Bucket as MountableBucket,
} from "../../FUSE/Mount.ts";
// type-only: erased at runtime, so no cycle with the router that
// value-imports this strategy
import type {
  TigrisfsStrategy,
  TigrisfsTarget,
} from "../../FUSE/MountTigrisfs.ts";
import * as Output from "../../Output.ts";
import { LOCAL_ID_PREFIX } from "../../ProviderMode.ts";
import { Self } from "../../Self.ts";
import { AccountApiToken } from "../ApiToken/AccountApiToken.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import { accessKey, s3Endpoint } from "./AccessKey.ts";
import type { Bucket } from "./Bucket.ts";

/**
 * The R2 {@link TigrisfsStrategy} — how tigrisfs gets authority over an
 * R2 bucket. Live: mint one scoped {@link AccountApiToken} per host
 * (`Workers R2 Storage Read`/`Write`), derive R2's S3 credentials from
 * it, and bind them — plus the bucket's identity — into the host's
 * environment. Under `alchemy dev`: no token — bind the FUSE marker so
 * the dev Docker interceptor grants the device/capability and injects
 * the local S3 gateway's URL, then mount the simulator bucket through
 * it.
 *
 * Consumed by `FUSE.MountTigrisfs`, which routes on the bucket's
 * resource type — this module never sees other clouds' buckets.
 */
export const R2Tigrisfs: TigrisfsStrategy = {
  plan: (mountable, _options) =>
    Effect.gen(function* () {
      const bucket = narrow(mountable);
      // register the identity accessors in BOTH modes (runtime reads
      // them back from the bound env)
      yield* bucket.bucketName;
      yield* bucket.jurisdiction;
      const dev = Option.match(yield* Effect.serviceOption(AlchemyContext), {
        onNone: () => false,
        onSome: (context) => context.dev,
      });
      if (dev) {
        // no token in dev — the bucket is the local simulator's. The
        // marker env asks the dev Docker interceptor to grant this
        // container the FUSE device/capability and inject the local
        // S3 gateway's URL; nothing else is bound.
        // NOTE: an `Alchemy.remote()`-pinned bucket under dev is not
        // supported by FUSE.Mount yet (no token is minted here, so the
        // runtime's live path would find no credentials).
        yield* Output.named(Output.literal("1"), R2_FUSE_MARKER_ENV);
        return;
      }
      yield* liveCredentials(bucket);
    }),

  runtime: (mountable, options) =>
    Effect.gen(function* () {
      const bucket = narrow(mountable);
      const name = yield* yield* bucket.bucketName;
      if (name.startsWith(LOCAL_ID_PREFIX)) {
        // dev: mount the LOCAL simulator bucket through the dev session's
        // S3 gateway (URL injected by the Docker create interceptor).
        // The bucket argument must be colon-free — tigrisfs splits its
        // bucket argument on the first colon (`bucket:prefix`), and
        // local ids are `dev:<uuid>` — so pass the gateway's alias.
        const endpoint = yield* Effect.sync(
          () => process.env[S3_GATEWAY_URL_ENV],
        );
        if (endpoint === undefined) {
          return yield* Effect.die(
            new MountError({
              message:
                `${S3_GATEWAY_URL_ENV} is not set — dev FUSE mounts require the ` +
                `container to be created through alchemy dev's Docker proxy ` +
                `(is ${R2_FUSE_MARKER_ENV} bound on this container?)`,
            }),
          );
        }
        const alias = encodeS3BucketAlias(name);
        return {
          bucket: options?.prefix ? `${alias}:${options.prefix}` : alias,
          endpoint,
          // the gateway does not authenticate; the signer needs SOME key
          accessKeyId: "alchemy-dev",
          secretAccessKey: Redacted.make("alchemy-dev"),
          args: DEV_TIGRISFS_ARGS,
        } satisfies TigrisfsTarget;
      }

      const { accessKeyId, secretAccessKey, accountId } =
        yield* liveCredentials(bucket);
      const jurisdiction = yield* yield* bucket.jurisdiction;
      return {
        bucket: options?.prefix ? `${name}:${options.prefix}` : name,
        endpoint: s3Endpoint(yield* accountId, jurisdiction),
        accessKeyId: yield* accessKeyId,
        secretAccessKey: yield* secretAccessKey,
        args: LIVE_TIGRISFS_ARGS,
      } satisfies TigrisfsTarget;
    }),
};

/**
 * `FUSE.MountTigrisfs` routes on `Type === "Cloudflare.R2.Bucket"`
 * before calling this strategy, so the narrow is a formality — but keep
 * it a loud one in case a future router regresses.
 */
const narrow = (mountable: MountableBucket): Bucket => {
  if (mountable.Type !== "Cloudflare.R2.Bucket") {
    throw new Error(
      `R2Tigrisfs received a '${mountable.Type}' — the FUSE.MountTigrisfs router should have picked a different strategy.`,
    );
  }
  return mountable as Bucket;
};

/**
 * The LIVE credential surface — one shape for both phases so the env
 * keys always agree: at plan time yielding the Outputs registers the
 * env bindings; at runtime the same yields hand back accessors reading
 * them.
 *
 * The requirements this resolves (the host `Self`, the Cloudflare
 * environment, the stack's providers behind the token constructor) are
 * ambient in the host's init on both phases; the strategy interface
 * erases them (mirroring `LocalR2Gateway`'s ambient-context rationale),
 * so resolution is via `serviceOption` + a loud die.
 */
const liveCredentials = (bucket: Bucket) =>
  Effect.gen(function* () {
    const self = yield* Effect.serviceOption(Self).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.die(
              new MountError({
                message:
                  "R2Tigrisfs could not resolve the host (`Self`) — FUSE.Mount must be bound inside a host's `.make()` init.",
              }),
            ),
          onSome: Effect.succeed,
        }),
      ),
    );
    const token = yield* AccountApiToken(
      `${self.LogicalId}FuseToken`,
    ) as Effect.Effect<AccountApiToken>;
    if (!globalThis.__ALCHEMY_RUNTIME__) {
      const environment = yield* Effect.serviceOption(
        CloudflareEnvironment,
      ).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.die(
                new MountError({
                  message:
                    "R2Tigrisfs could not resolve CloudflareEnvironment — is the Cloudflare provider in the stack's context?",
                }),
              ),
            onSome: Effect.succeed,
          }),
        ),
      );
      const { accountId } = yield* environment;
      yield* token.bind`${bucket.LogicalId}Fuse`({
        policies: [
          {
            effect: "allow",
            permissionGroups: [
              "Workers R2 Storage Read",
              "Workers R2 Storage Write",
            ],
            resources: {
              [`com.cloudflare.api.account.${accountId}`]: "*",
            },
          },
        ],
      });
    }
    // env accessors — registered at plan time, read back at runtime.
    // The derived secret is an EffectExpr whose auto-generated key
    // embeds fn.toString(), so it MUST be named to survive bundling.
    const credentials = accessKey(token);
    return {
      accessKeyId: yield* Output.named(
        credentials.accessKeyId,
        `${self.LogicalId}FuseAccessKeyId`,
      ),
      secretAccessKey: yield* Output.named(
        credentials.secretAccessKey,
        `${self.LogicalId}FuseSecretAccessKey`,
      ),
      accountId: yield* token.accountId,
    };
  });

/**
 * Dev flags: `--no-detect` skips the region/SigV2 probing the gateway
 * doesn't serve, `--no-expire-multipart` avoids ListMultipartUploads
 * (not implemented), and `--list-type 2` selects the V2 listing the
 * gateway is tested against. Path-style addressing is tigrisfs's
 * default, which is exactly what the gateway's `/{bucket}/{key}`
 * routes expect. `--stat-cache-ttl 1s` (default 1m) keeps the mount
 * honest about OTHER writers — in dev the same bucket is concurrently
 * written through worker bindings, and geesefs treats its cached
 * listings as authoritative for lookups.
 */
const DEV_TIGRISFS_ARGS = [
  "--no-detect",
  "--no-expire-multipart",
  "--list-type",
  "2",
  "--stat-cache-ttl",
  "1s",
] as const;

/**
 * Live flags: R2 requires every part of a multipart upload except the
 * last to be the SAME size, but geesefs's default `--part-sizes`
 * schedule grows part sizes in stages (5 MiB × 1000, then 25 MiB, …) —
 * files over 5 GiB would hit the growth boundary and fail. One uniform
 * 25 MiB part size satisfies R2 up to 25 MiB × 10000 = ~244 GiB per
 * file. Caller `args` come after, so this is overridable.
 */
const LIVE_TIGRISFS_ARGS = ["--part-sizes", "25"] as const;
