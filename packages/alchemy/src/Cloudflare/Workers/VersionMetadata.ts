import type * as Effect from "effect/Effect";
import { SingleShotGen } from "effect/Utils";
import {
  VersionMetadataBinding,
  type VersionMetadataAccessor,
} from "./VersionMetadataBinding.ts";

type VersionMetadataTypeId = typeof VersionMetadataTypeId;
const VersionMetadataTypeId = "Cloudflare.VersionMetadata" as const;

export type VersionMetadataProps = {
  /**
   * Binding name used when `VersionMetadata` is bound from inside a Worker init
   * phase (`yield* Cloudflare.VersionMetadata(...)`). When passed through
   * `Worker({ env: { ... } })`, the object key remains the binding name.
   *
   * @default "CF_VERSION_METADATA"
   */
  name?: string;
};

/**
 * The Effect yielded when a `VersionMetadata` marker is used inside a Worker
 * init phase: it attaches the `version_metadata` binding to the surrounding
 * Worker and resolves to a deferred {@link VersionMetadataAccessor}.
 */
type BindEffect = Effect.Effect<
  VersionMetadataAccessor,
  never,
  VersionMetadataBinding
>;

/**
 * Marker for a Cloudflare Workers Version Metadata binding.
 *
 * It is a plain data structure (so it can be declared directly on a Worker's
 * `env`) that is **also** yieldable inside an Effect-native Worker. Yielding it
 * (`yield* Cloudflare.VersionMetadata(...)`) attaches the binding to the
 * surrounding Worker and returns a deferred accessor for the runtime
 * {@link import("./VersionMetadataBinding.ts").WorkerVersionMetadata}.
 *
 * The divergence is achieved via `[Symbol.iterator]`: the object is
 * deliberately not an `Effect` (so `InferEnv` and the Worker `env` resolver
 * keep it as the native version metadata rather than `yield*`-ing it), but it
 * is iterable as one when `yield*`-ed.
 */
export type VersionMetadata = {
  kind: VersionMetadataTypeId;
  name: string;
  asEffect(): BindEffect;
  [Symbol.iterator](): SingleShotGen<BindEffect, VersionMetadataAccessor>;
};

export const isVersionMetadata = (value: unknown): value is VersionMetadata =>
  typeof value === "object" &&
  value !== null &&
  "kind" in value &&
  (value as VersionMetadata).kind === VersionMetadataTypeId;

/**
 * A Cloudflare Workers Version Metadata binding.
 *
 * Cloudflare provides the deployed Worker version at runtime (`id`, `tag`,
 * `timestamp`).
 *
 * @binding
 * @product Workers
 * @category Workers & Compute
 *
 * @section Effect-style Worker (recommended)
 * @example Read the deployed version from inside a handler
 * ```typescript
 * import * as Effect from "effect/Effect";
 *
 * Cloudflare.Worker(
 *   "VersionWorker",
 *   { main: import.meta.filename },
 *   Effect.gen(function* () {
 *     // Attaches the binding to this Worker AND returns a deferred accessor.
 *     const versionMetadata = yield* Cloudflare.VersionMetadata();
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { id, tag, timestamp } = yield* versionMetadata;
 *         return Response.json({ id, tag, timestamp });
 *       }),
 *     };
 *   }).pipe(Effect.provide(Cloudflare.VersionMetadataBindingLive)),
 * );
 * ```
 *
 * @section Worker binding metadata
 * @example
 * ```typescript
 * export const Worker = Cloudflare.Worker("Worker", {
 *   main: "./src/worker.ts",
 *   env: {
 *     CF_VERSION_METADATA: Cloudflare.VersionMetadata(),
 *   },
 * });
 *
 * export type WorkerEnv = Cloudflare.InferEnv<typeof Worker>;
 * //   { CF_VERSION_METADATA: WorkerVersionMetadata }
 * ```
 *
 * @see https://developers.cloudflare.com/workers/runtime-apis/bindings/version-metadata/
 */
export const VersionMetadata: {
  (props?: VersionMetadataProps): VersionMetadata;
  /**
   * Bind an existing `VersionMetadata` marker to the surrounding Worker,
   * returning the deferred accessor. Equivalent to `yield* versionMetadata` —
   * prefer yielding the marker directly.
   */
  bind: typeof VersionMetadataBinding.bind;
} = Object.assign(
  (props?: VersionMetadataProps): VersionMetadata => {
    const self: VersionMetadata = {
      kind: VersionMetadataTypeId,
      name: props?.name ?? "CF_VERSION_METADATA",
      asEffect: () => VersionMetadataBinding.bind(self),
      [Symbol.iterator]: () =>
        new SingleShotGen(VersionMetadataBinding.bind(self)),
    };
    return self;
  },
  {
    bind: (...args: Parameters<typeof VersionMetadataBinding.bind>) =>
      VersionMetadataBinding.bind(...args),
  },
);
