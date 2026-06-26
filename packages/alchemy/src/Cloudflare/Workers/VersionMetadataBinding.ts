import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import type { ResourceLike } from "../../Resource.ts";
import type { VersionMetadata as VersionMetadataLike } from "./VersionMetadata.ts";
import { isWorker, WorkerEnvironment } from "./Worker.ts";
import type { Providers } from "../Providers.ts";

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
export class VersionMetadataBinding extends Binding.Service<
  VersionMetadataBinding,
  (
    versionMetadata: VersionMetadataLike,
  ) => Effect.Effect<VersionMetadataAccessor>
>()("Cloudflare.VersionMetadata") {}

export const VersionMetadataBindingLive = Layer.effect(
  VersionMetadataBinding,
  Effect.gen(function* () {
    const Policy = yield* VersionMetadataBindingPolicy;

    return Effect.fn(function* (versionMetadata: VersionMetadataLike) {
      yield* Policy(versionMetadata);
      return WorkerEnvironment.useSync(
        (env) =>
          (env as Record<string, WorkerVersionMetadata>)[versionMetadata.name]!,
      );
    });
  }),
);

export class VersionMetadataBindingPolicy extends Binding.Policy<
  VersionMetadataBindingPolicy,
  (versionMetadata: VersionMetadataLike) => Effect.Effect<void>,
  Providers
>()("Cloudflare.VersionMetadata") {}

export const VersionMetadataBindingPolicyLive =
  VersionMetadataBindingPolicy.layer.succeed(
    Effect.fn(function* (
      host: ResourceLike,
      versionMetadata: VersionMetadataLike,
    ) {
      if (isWorker(host)) {
        yield* host.bind(versionMetadata.name, {
          bindings: [
            {
              type: "version_metadata",
              name: versionMetadata.name,
            },
          ],
        });
      } else {
        return yield* Effect.die(
          new Error(
            `VersionMetadataBinding does not support runtime '${host.Type}'`,
          ),
        );
      }
    }),
  );
