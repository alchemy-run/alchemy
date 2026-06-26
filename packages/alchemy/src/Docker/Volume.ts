import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import { identity } from "effect/Function";
import { Unowned } from "../AdoptPolicy.ts";
import { isResolved } from "../Diff.ts";
import { createPhysicalName } from "../PhysicalName.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { Docker } from "./Docker.ts";
import type { Providers } from "./Providers.ts";

export interface VolumeLabel {
  /** Label name. */
  name: string;
  /** Label value. */
  value: string;
}

export interface VolumeProps {
  /**
   * Docker volume name.
   *
   * @default Generated from stack, stage, logical id, and instance id.
   */
  name?: string;
  /** Volume driver. @default "local" */
  driver?: string;
  /** Driver-specific options. */
  driverOpts?: Record<string, string>;
  /** Custom metadata labels. */
  labels?: Record<string, string>;
}

export interface Volume extends Resource<
  "Docker.Volume",
  VolumeProps,
  {
    /** Docker volume name. */
    id: string;
    /** Docker volume name. */
    name: string;
    /** Volume driver. */
    driver: string;
    /** Driver-specific options reported by Docker. */
    driverOpts: Record<string, string>;
    /** Labels reported by Docker. */
    labels: Record<string, string>;
    /** Host mountpoint path. */
    mountpoint?: string;
    /** Creation timestamp in milliseconds since epoch. */
    createdAt: number;
  },
  never,
  Providers
> {}

/**
 * A Docker volume managed through the active Docker context.
 *
 * Pre-existing same-name volumes are treated as foreign until the engine is
 * allowed to adopt them with `--adopt` or `adopt(true)`.
 *
 * @resource
 *
 * @section Creating Volumes
 * @example Basic volume
 * ```typescript
 * const data = yield* Docker.Volume("data", {
 *   name: "app-data",
 * });
 * ```
 *
 * @example PostgreSQL data volume
 * ```typescript
 * const data = yield* Docker.Volume("postgres-data");
 * ```
 *
 * @example Driver options and labels
 * ```typescript
 * const data = yield* Docker.Volume("db-data", {
 *   driver: "local",
 *   driverOpts: {
 *     type: "nfs",
 *     o: "addr=10.0.0.1,rw",
 *     device: ":/path/to/dir",
 *   },
 *   labels: {
 *     "com.example.usage": "database",
 *   },
 * });
 * ```
 */
export const Volume = Resource<Volume>("Docker.Volume");

export const VolumeProvider = () =>
  Provider.effect(
    Volume,
    Effect.gen(function* () {
      const docker = yield* Docker;

      return Volume.Provider.of({
        list: () => Effect.succeed([]),
        read: Effect.fn(({ id, instanceId, olds, output }) =>
          volumeName(id, olds ?? {}, instanceId).pipe(
            Effect.flatMap(docker.volume.inspect),
            Effect.map(toVolumeAttributes),
            Effect.map(output ? identity : Unowned),
            Effect.catchReason(
              "PlatformError",
              "NotFound",
              () => Effect.undefined,
            ),
          ),
        ),
        diff: Effect.fn(function* ({ id, instanceId, output, news }) {
          if (!isResolved(news)) return undefined;
          const args = yield* makeVolumeArgs(id, news, instanceId);
          if (
            output?.name !== args.name ||
            output?.driver !== args.driver ||
            !Equal.equals(output?.driverOpts ?? {}, args.opt ?? {}) ||
            !Equal.equals(output?.labels ?? {}, args.label ?? {})
          ) {
            return { action: "replace" as const, deleteFirst: true };
          }
        }),
        reconcile: Effect.fn(({ id, instanceId, news }) =>
          makeVolumeArgs(id, news, instanceId).pipe(
            Effect.flatMap(docker.volume.create),
            Effect.flatMap((result) => docker.volume.inspect(result.stdout)),
            Effect.map(toVolumeAttributes),
          ),
        ),
        delete: Effect.fn(({ output }) =>
          docker.volume
            .remove(output.name)
            .pipe(
              Effect.catchReason(
                "PlatformError",
                "NotFound",
                () => Effect.void,
              ),
            ),
        ),
      });
    }),
  );

const volumeName = (id: string, props: VolumeProps, instanceId: string) =>
  props.name
    ? Effect.succeed(props.name)
    : createPhysicalName({
        id,
        instanceId,
        maxLength: 128,
        lowercase: true,
      });

const makeVolumeArgs = (id: string, props: VolumeProps, instanceId: string) =>
  volumeName(id, props, instanceId).pipe(
    Effect.map(
      (name): Parameters<Docker["Service"]["volume"]["create"]>[0] => ({
        name,
        driver: props.driver ?? "local",
        opt: props.driverOpts,
        label: props.labels,
      }),
    ),
  );

export const toVolumeAttributes = (
  info: Docker.Volume,
): Volume["Attributes"] => ({
  id: info.Name,
  name: info.Name,
  driver: info.Driver,
  driverOpts: info.Options ?? {},
  labels: info.Labels ?? {},
  mountpoint: info.Mountpoint,
  createdAt: Date.parse(info.CreatedAt) || Date.now(),
});
