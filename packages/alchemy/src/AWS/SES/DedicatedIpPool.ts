import * as sesv2 from "@distilled.cloud/aws/sesv2";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, createTagsList } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";

/**
 * The pool's scaling mode. `STANDARD` pools use a fixed set of dedicated IPs
 * you request and warm up yourself; `MANAGED` pools let SES automatically
 * scale the dedicated IP capacity for you.
 */
export type DedicatedIpPoolScalingMode = sesv2.ScalingMode;

export interface DedicatedIpPoolProps {
  /**
   * Name of the dedicated IP pool. May contain lowercase letters, numbers and
   * dashes, up to 64 characters. If omitted, a deterministic lowercase
   * physical name is generated from the app, stage, and logical ID. Changing
   * the name replaces the pool.
   */
  poolName?: string;
  /**
   * The pool's scaling mode. Switching `STANDARD` → `MANAGED` is applied in
   * place via `putDedicatedIpPoolScalingAttributes`; AWS does not support
   * `MANAGED` → `STANDARD`, so that direction replaces the pool.
   * @default "STANDARD"
   */
  scalingMode?: DedicatedIpPoolScalingMode;
}

export interface DedicatedIpPool extends Resource<
  "AWS.SES.DedicatedIpPool",
  DedicatedIpPoolProps,
  {
    /** Name of the dedicated IP pool. */
    poolName: string;
    /** The pool's scaling mode. */
    scalingMode: DedicatedIpPoolScalingMode;
  },
  never,
  Providers
> {}

/**
 * An Amazon SES v2 dedicated IP pool — a named group of dedicated IP addresses
 * used to send email, so you can isolate the sending reputation of different
 * kinds of mail (e.g. marketing vs. transactional).
 *
 * :::caution
 * Creating a dedicated IP pool provisions dedicated IP capacity and **starts
 * billing immediately** — `MANAGED` pools bill for managed dedicated IP usage
 * as soon as they exist, and `STANDARD` pools bill per dedicated IP you add.
 * Only create pools you intend to pay for.
 * :::
 *
 * `STANDARD` → `MANAGED` is an in-place scaling change. `MANAGED` → `STANDARD`
 * is not supported by AWS and replaces the pool.
 * @resource
 * @section Creating Pools
 * @example Standard Pool
 * ```typescript
 * import * as SES from "alchemy/AWS/SES";
 *
 * const pool = yield* SES.DedicatedIpPool("Marketing", {
 *   scalingMode: "STANDARD",
 * });
 * ```
 *
 * @example Managed Pool
 * ```typescript
 * const pool = yield* SES.DedicatedIpPool("Transactional", {
 *   scalingMode: "MANAGED",
 * });
 * ```
 */
export const DedicatedIpPool = Resource<DedicatedIpPool>(
  "AWS.SES.DedicatedIpPool",
);

const DEFAULT_SCALING_MODE = "STANDARD" as const;

export const DedicatedIpPoolProvider = () =>
  Provider.effect(
    DedicatedIpPool,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: Pick<DedicatedIpPoolProps, "poolName">,
      ) {
        return (
          props.poolName ??
          (yield* createPhysicalName({ id, maxLength: 64, lowercase: true }))
        );
      });

      const getPool = Effect.fn(function* (name: string) {
        return yield* sesv2.getDedicatedIpPool({ PoolName: name }).pipe(
          Effect.map((response) => response.DedicatedIpPool),
          Effect.catchTag("NotFoundException", () => Effect.succeed(undefined)),
        );
      });

      return DedicatedIpPool.Provider.of({
        stables: ["poolName"],

        // Account/region-scoped: enumerate every pool so leaked test resources
        // are cleaned by nuke.
        list: Effect.fn(function* () {
          const pages = yield* sesv2.listDedicatedIpPools
            .pages({})
            .pipe(Stream.runCollect);
          return Array.from(pages)
            .flatMap((page) => page.DedicatedIpPools ?? [])
            .map((poolName) => ({
              poolName,
              scalingMode: DEFAULT_SCALING_MODE as DedicatedIpPoolScalingMode,
            }));
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const name = output?.poolName ?? (yield* createName(id, olds ?? {}));
          const found = yield* getPool(name);
          return found
            ? { poolName: name, scalingMode: found.ScalingMode }
            : undefined;
        }),

        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createName(id, olds ?? {});
          const newName = yield* createName(id, news ?? {});
          const oldMode = olds?.scalingMode ?? DEFAULT_SCALING_MODE;
          const newMode = news?.scalingMode ?? DEFAULT_SCALING_MODE;
          // A rename replaces the pool. So does a MANAGED → STANDARD switch,
          // which AWS has no API to perform in place (STANDARD → MANAGED is a
          // supported in-place scaling change, handled in reconcile).
          if (
            oldName !== newName ||
            (oldMode === "MANAGED" && newMode === "STANDARD")
          ) {
            return { action: "replace" } as const;
          }
        }),

        reconcile: Effect.fn(function* ({ id, news, output }) {
          const name = output?.poolName ?? (yield* createName(id, news));
          const desiredMode = news.scalingMode ?? DEFAULT_SCALING_MODE;

          // 1. OBSERVE — cloud state is authoritative.
          let observed = yield* getPool(name);

          if (observed === undefined) {
            // 2. ENSURE — create with the desired scaling mode, branding the
            //    pool with internal tags. AlreadyExists is a race, not a
            //    failure.
            const internalTags = yield* createInternalTags(id);
            yield* sesv2
              .createDedicatedIpPool({
                PoolName: name,
                ScalingMode: desiredMode,
                Tags: createTagsList(internalTags),
              })
              .pipe(
                Effect.catchTag("AlreadyExistsException", () =>
                  Effect.succeed({}),
                ),
              );
            observed = yield* getPool(name);
          }

          // 3. SYNC — the only in-place scaling change AWS supports is
          //    STANDARD → MANAGED (MANAGED → STANDARD is a replacement, gated
          //    in diff above).
          if (observed?.ScalingMode !== desiredMode) {
            yield* sesv2.putDedicatedIpPoolScalingAttributes({
              PoolName: name,
              ScalingMode: desiredMode,
            });
          }

          return { poolName: name, scalingMode: desiredMode };
        }),

        delete: Effect.fn(function* ({ output }) {
          // deleteDedicatedIpPool is idempotent for a missing pool.
          yield* sesv2
            .deleteDedicatedIpPool({ PoolName: output.poolName })
            .pipe(Effect.catchTag("NotFoundException", () => Effect.void));
        }),
      });
    }),
  );
