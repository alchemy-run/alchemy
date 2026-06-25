import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import type { VersionMetadata as VersionMetadataLike } from "./VersionMetadata.ts";
import { isWorker, WorkerEnvironment } from "./Worker.ts";

/**
 * Runtime value Cloudflare exposes for a `version_metadata` binding — the
 * deployed Worker version's `id`, `tag`, and `timestamp`.
 */
export interface WorkerVersionMetadata {
  readonly id: string;
  readonly tag: string;
  readonly timestamp: string;
}

/**
 * Effect-native accessor for a Cloudflare Workers Version Metadata binding.
 *
 * The Worker env binding only exists at the *exec* phase on the deployed
 * Worker, so reading it is deferred behind an Effect that requires
 * {@link WorkerEnvironment}. Yield it inside a handler to obtain the
 * {@link WorkerVersionMetadata}.
 */
export type VersionMetadataAccessor = Effect.Effect<
  WorkerVersionMetadata,
  never,
  WorkerEnvironment
>;

/**
 * @binding
 * @product Workers
 * @category Workers & Compute
 */
export interface VersionMetadataBinding extends Binding.Service<
  VersionMetadataBinding,
  "Cloudflare.Workers.VersionMetadata",
  (
    versionMetadata: VersionMetadataLike,
  ) => Effect.Effect<VersionMetadataAccessor>
> {}

export const VersionMetadataBinding = Binding.Service<VersionMetadataBinding>(
  "Cloudflare.Workers.VersionMetadata",
);

export const VersionMetadataBindingLayer = Layer.effect(
  VersionMetadataBinding,
  Effect.gen(function* () {
    return Effect.fn(function* (versionMetadata: VersionMetadataLike) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isWorker(host)) {
          yield* host.bind(versionMetadata.name, {
            bindings: [
              { type: "version_metadata", name: versionMetadata.name },
            ],
          });
        }
      }
      return WorkerEnvironment.useSync(
        (env) =>
          (env as Record<string, WorkerVersionMetadata>)[versionMetadata.name]!,
      );
    });
  }),
);
