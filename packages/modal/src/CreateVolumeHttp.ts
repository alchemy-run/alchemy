import * as volume from "@distilled.cloud/modal/volume";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeOpenModalBinding } from "./BindingHttp.ts";
import { CreateVolume, type VolumeHandle, type VolumesClientOf } from "./CreateVolume.ts";
import type { Environment } from "./Environment.ts";
import { environmentOf, listAll, operations } from "./internal.ts";
import { type CreateOptions, RuntimeStamp, stampedName, unstampedName } from "./RuntimeObjects.ts";
import { ensureVolume, lookupVolume, type VolumeAttributes } from "./Volume.ts";
import { makeReadWriteVolumeClient } from "./VolumeClient.ts";
import { VolumeFileOps } from "./VolumeFiles.ts";

/** The operations the client calls, resolved by `ModalBindings.withCredentials`. */
export const VolumesOps = operations({
  getOrCreate: volume.volumeGetOrCreate,
  delete: volume.deleteVolume,
  list: volume.listVolume,
  client: VolumeFileOps,
});

export type VolumesOps = Effect.Success<typeof VolumesOps>;

const handleOf = (attributes: VolumeAttributes, ops: VolumesOps, name: string): VolumeHandle => ({
  ...makeReadWriteVolumeClient(Effect.succeed(attributes.volumeId), ops.client),
  volumeId: Effect.succeed(attributes.volumeId),
  name,
  attributes,
});

/** A volumes client over an environment name resolved per call. */
export const makeVolumesClient = (
  environment: Effect.Effect<string | undefined>,
  ops: VolumesOps,
  prefix: Effect.Effect<string | undefined> = Effect.undefined,
): VolumesClientOf<never> => ({
  getOrCreate: (name) =>
    Effect.flatMap(Effect.all([environment, prefix]), ([env, stamp]) =>
      ensureVolume(ops.getOrCreate, stampedName(stamp, name), env),
    ).pipe(Effect.map((attributes) => handleOf(attributes, ops, name))),
  get: (name) =>
    Effect.flatMap(Effect.all([environment, prefix]), ([env, stamp]) =>
      lookupVolume(ops.getOrCreate, stampedName(stamp, name), env),
    ).pipe(Effect.map((attributes) => (attributes ? handleOf(attributes, ops, name) : undefined))),
  delete: (name) =>
    Effect.gen(function* () {
      const env = yield* environment;
      const found = yield* lookupVolume(ops.getOrCreate, stampedName(yield* prefix, name), env);
      if (!found) return;
      yield* ops
        .delete({ volumeId: found.volumeId, environmentName: environmentOf(env) })
        .pipe(Effect.catchTag("VolumeNotFound", () => Effect.void));
    }),
  list: () =>
    Effect.gen(function* () {
      const env = yield* environment;
      const stamp = yield* prefix;
      const items = yield* listAll(
        (pagination) =>
          ops
            .list({ environmentName: environmentOf(env), pagination })
            .pipe(Effect.map((response) => response.items ?? [])),
        (item) => item.createdAt,
      );
      return items.flatMap((item) => {
        const name = item.label ?? item.metadata?.name;
        const own = name ? unstampedName(stamp, name) : undefined;
        return own ? [own] : [];
      });
    }),
});

/**
 * {@link CreateVolume} over Modal's API. Grants the host's identity (a scoped
 * `Modal.ServiceUser`) the `contributor` role on the environment.
 *
 * @layer
 * @product Volume
 * @provides Modal.CreateVolume
 */
export const CreateVolumeHttp = Layer.effect(
  CreateVolume,
  Effect.gen(function* () {
    const runtimeStamp = yield* RuntimeStamp;
    return yield* makeOpenModalBinding({
      tag: "Modal.CreateVolume",
      operations: VolumesOps,
      role: "contributor",
      environmentOf: (environment?: Environment, _options?: CreateOptions) => environment?.name,
      make: Effect.fn(function* (ops, environment?: Environment, options?: CreateOptions) {
        const name = environment ? yield* environment.name : Effect.undefined;
        const stamp = yield* runtimeStamp("volume", environment, options);
        return makeVolumesClient(name, ops, stamp);
      }),
    });
  }),
);
