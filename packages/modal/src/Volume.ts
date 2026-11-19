import * as volume from "@distilled.cloud/modal/volume";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import {
  type EnvironmentInput,
  envNameOf,
  environmentNames,
  environmentOf,
  isGeneratedName,
  listAll,
  objectName,
} from "./internal.ts";
import { declarable } from "./internal/Declared.ts";
import type { Providers } from "./Providers.ts";
import { isRuntimeName } from "./RuntimeOwner.ts";

export class VolumeUnexpectedResponse extends Data.TaggedError("Modal.VolumeUnexpectedResponse")<{
  readonly message: string;
}> {}

export interface VolumeProps {
  /**
   * Volume name, unique per environment. If omitted, a unique name is
   * generated from the stack, stage and logical ID. Changing it renames the
   * volume in place.
   */
  name?: string;
  /**
   * Environment the volume lives in. Changing it replaces the volume.
   * @default the workspace's default environment
   */
  environment?: EnvironmentInput;
  /**
   * Volume filesystem version. `2` supports many concurrent writers and
   * files of any count; `1` is Modal's original format. Changing it
   * replaces the volume.
   * @default 2
   */
  version?: 1 | 2;
}

export interface VolumeAttributes {
  /** Volume ID (`vo-…`). */
  volumeId: string;
  /** Volume name. */
  name: string;
  /** Environment name, or `undefined` for the workspace default. */
  environment: string | undefined;
  /** Volume filesystem version. */
  version: 1 | 2;
}

/**
 * A Modal Volume: a persistent, shared filesystem that Sandboxes and
 * Functions mount at a path. Writes from one container become visible to
 * others after a commit (Sandboxes commit when they exit).
 *
 * Declare a Volume here for data every deployment shares, such as a model
 * cache or a dataset. For one volume per user or session, create them at
 * runtime with {@link CreateVolume}; to read and write files from a Worker or
 * Lambda without a sandbox, bind {@link ReadWriteVolume}.
 *
 * Modal volumes have no tags. Ownership is inferred from Alchemy state: a
 * volume found under an explicit `name` without prior state is reported as
 * unowned.
 *
 * ### Creating a Volume
 * **Example:** A volume with a generated name
 * ```typescript
 * import * as Modal from "@alchemy.run/modal";
 *
 * export const Cache = Modal.Volume("Cache", {});
 * ```
 *
 * **Example:** A named volume in an environment
 * ```typescript
 * import * as Modal from "@alchemy.run/modal";
 *
 * export const Agents = Modal.Environment("Agents", {});
 * export const Models = Modal.Volume("Models", { name: "model-weights", environment: Agents });
 * ```
 *
 * ### Mounting in a Sandbox
 * **Example:** Mount at `/cache`
 * ```typescript
 * // construction phase
 * const cache = yield* Modal.MountVolume(Cache, { path: "/cache" });
 * const sandboxes = yield* Modal.CreateSandbox(Coder);
 * // per request
 * const sandbox = yield* sandboxes.create({ mounts: [cache] });
 * ```
 *
 * ### Reading files from a Worker
 * **Example:** Bind file access
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Modal from "@alchemy.run/modal";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 * import { Cache } from "./Storage.ts";
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const cache = yield* Modal.ReadWriteVolume(Cache);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* cache.writeFile("/hello.txt", "hello");
 *         const text = yield* cache.readFileString("/hello.txt");
 *         return HttpServerResponse.text(text);
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Modal.ReadWriteVolumeHttp)),
 * ) {}
 * ```
 *
 * ### Looking up an existing volume
 * `Volume.lookup` references a volume Alchemy doesn't manage (created with
 * the Modal CLI or by another stack). It is read during plan/deploy, never
 * created, updated or deleted.
 *
 * **Example:** Reference an existing volume
 * ```typescript
 * const weights = Modal.Volume.lookup({ name: "model-weights" });
 * ```
 *
 * @resource
 * @product Volume
 */
export const Volume = declarable<Volume>()(Resource<Volume>("Modal.Volume"));

export type Volume = Resource<
  "Modal.Volume",
  VolumeProps,
  VolumeAttributes,
  never,
  Providers,
  VolumeLookup
>;

/**
 * Props for {@link Volume.lookup}: find a volume this stack
 * doesn't manage by its name.
 */
export interface VolumeLookup {
  /** Volume name. */
  name: string;
  /**
   * Modal environment the object lives in.
   * @default the workspace's default environment
   */
  environment?: string;
}

const versionToWire = (version: 1 | 2 | undefined): volume.VolumeFsVersion =>
  version === 1 ? "VOLUME_FS_VERSION_V1" : "VOLUME_FS_VERSION_V2";

const versionFromWire = (version: string | undefined): 1 | 2 =>
  version === "VOLUME_FS_VERSION_V1" ? 1 : 2;

/** A volume by name, or `undefined` when missing. */
export const lookupVolume = Effect.fn(function* (
  getOrCreate: Effect.Success<typeof volume.volumeGetOrCreate>,
  name: string,
  env: string | undefined,
) {
  const found = yield* getOrCreate({
    deploymentName: name,
    environmentName: environmentOf(env),
    objectCreationType: "OBJECT_CREATION_TYPE_UNSPECIFIED",
  }).pipe(Effect.catchTag("VolumeNotFound", () => Effect.undefined));
  if (!found?.volumeId) return undefined;
  return {
    volumeId: found.volumeId,
    name,
    environment: env,
    version: versionFromWire(found.version ?? found.metadata?.version),
  } satisfies VolumeAttributes;
});

/**
 * Get a volume by name, creating it when missing: the one implementation
 * behind {@link Volume}'s reconcile and the runtime {@link CreateVolume}
 * client.
 */
export const ensureVolume = Effect.fn(function* (
  getOrCreate: Effect.Success<typeof volume.volumeGetOrCreate>,
  name: string,
  env: string | undefined,
  version?: 1 | 2,
) {
  const created = yield* getOrCreate({
    deploymentName: name,
    environmentName: environmentOf(env),
    objectCreationType: "OBJECT_CREATION_TYPE_CREATE_IF_MISSING",
    version: versionToWire(version),
  });
  if (!created.volumeId) {
    return yield* new VolumeUnexpectedResponse({
      message: `Modal returned no id for volume ${name}`,
    });
  }
  return {
    volumeId: created.volumeId,
    name: created.metadata?.name ?? name,
    environment: env,
    version: versionFromWire(created.version ?? created.metadata?.version),
  } satisfies VolumeAttributes;
});

export const VolumeProvider = () =>
  Provider.effect(
    Volume,
    Effect.gen(function* () {
      const observe = Effect.fn(function* (
        volumeId: string | undefined,
        name: string,
        env: string | undefined,
      ) {
        if (volumeId !== undefined) {
          const byId = yield* volume
            .volumeGetById({ volumeId })
            .pipe(Effect.catchTag("VolumeNotFound", () => Effect.undefined));
          if (byId?.volumeId) {
            return {
              volumeId: byId.volumeId,
              name: byId.metadata?.name ?? name,
              environment: env,
              version: versionFromWire(byId.metadata?.version),
            } satisfies VolumeAttributes;
          }
        }
        return yield* lookupVolume(yield* volume.volumeGetOrCreate, name, env);
      });

      return {
        stables: ["volumeId", "environment", "version"],
        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return undefined;
          if (envNameOf(news.environment) !== envNameOf(olds?.environment))
            return { action: "replace" } as const;
          if ((news.version ?? 2) !== (olds?.version ?? 2)) return { action: "replace" } as const;
          return undefined;
        }),
        lookup: Effect.fn(function* ({ name, environment }) {
          return yield* observe(undefined, name, environment);
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const name = output?.name ?? (yield* objectName(id, olds?.name));
          const observed = yield* observe(output?.volumeId, name, envNameOf(olds?.environment));
          if (!observed) return undefined;
          return output !== undefined || olds?.name === undefined ? observed : Unowned(observed);
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = yield* objectName(id, news.name);
          // Observe: the volume we created (by id) or one with the name.
          let current = yield* observe(
            output?.volumeId,
            output?.name ?? name,
            envNameOf(news.environment),
          );
          // Ensure
          if (!current) {
            yield* session.note(`Creating volume ${name}...`);
            current = yield* ensureVolume(
              yield* volume.volumeGetOrCreate,
              name,
              envNameOf(news.environment),
              news.version,
            );
          }
          // Sync the name: a renamed volume keeps its id and files.
          if (current.name !== name) {
            yield* session.note(`Renaming volume ${current.name} to ${name}...`);
            yield* volume.renameVolume({ volumeId: current.volumeId, name });
            current = { ...current, name };
          }
          return current;
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* volume
            .deleteVolume({
              volumeId: output.volumeId,
              environmentName: environmentOf(output.environment),
            })
            .pipe(Effect.catchTag("VolumeNotFound", () => Effect.void));
        }),
        list: Effect.fn(function* () {
          const envs = yield* environmentNames;
          const all: VolumeAttributes[] = [];
          for (const env of envs) {
            const items = yield* listAll(
              (pagination) =>
                volume
                  .listVolume({ environmentName: env, pagination })
                  .pipe(Effect.map((response) => response.items ?? [])),
              (item) => item.createdAt,
            );
            for (const item of items) {
              const name = item.label ?? item.metadata?.name;
              if (!item.volumeId || !(isGeneratedName(name) || isRuntimeName(name))) continue;
              all.push({
                volumeId: item.volumeId,
                name: name ?? "",
                environment: env,
                version: versionFromWire(item.metadata?.version),
              });
            }
          }
          return all;
        }),
      };
    }),
  );
