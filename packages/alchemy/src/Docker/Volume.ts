import * as Effect from "effect/Effect";
import { Unowned } from "../AdoptPolicy.ts";
import { deepEqual, isResolved } from "../Diff.ts";
import { createPhysicalName } from "../PhysicalName.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import {
  createVolume,
  inspectVolumeInfo,
  normalizeLabels,
  removeVolume,
  type VolumeInfo,
} from "./DockerApi.ts";

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
  labels?: VolumeLabel[] | Record<string, string>;
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
  }
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

const volumeName = (id: string, props: VolumeProps, instanceId: string) =>
  props.name
    ? Effect.succeed(props.name)
    : createPhysicalName({
        id,
        instanceId,
        maxLength: 128,
        lowercase: true,
      });

export const toVolumeAttributes = (info: VolumeInfo): Volume["Attributes"] => ({
  id: info.Name,
  name: info.Name,
  driver: info.Driver,
  driverOpts: info.Options ?? {},
  labels: info.Labels ?? {},
  mountpoint: info.Mountpoint,
  createdAt: Date.parse(info.CreatedAt) || Date.now(),
});

export const VolumeProvider = () =>
  Provider.succeed(Volume, {
    list: () => Effect.succeed([]),
    read: Effect.fnUntraced(function* ({ id, instanceId, olds, output }) {
      const name = yield* volumeName(id, olds ?? {}, instanceId);
      const info = yield* inspectVolumeInfo(name);
      if (!info) return undefined;
      const attrs = toVolumeAttributes(info);
      return output ? attrs : Unowned(attrs);
    }),
    diff: Effect.fnUntraced(function* ({ news, olds }) {
      if (!isResolved(news)) return undefined;
      const oldComparable = {
        name: olds?.name,
        driver: olds?.driver ?? "local",
        driverOpts: olds?.driverOpts ?? {},
        labels: normalizeLabels(olds?.labels),
      };
      const newComparable = {
        name: news?.name,
        driver: news?.driver ?? "local",
        driverOpts: news?.driverOpts ?? {},
        labels: normalizeLabels(news?.labels),
      };
      if (!deepEqual(oldComparable, newComparable)) {
        return { action: "replace" as const, deleteFirst: true };
      }
    }),
    reconcile: Effect.fnUntraced(function* ({
      id,
      instanceId,
      news,
      output,
      session,
    }) {
      const name =
        output?.name ?? (yield* volumeName(id, news ?? {}, instanceId));
      const existing = yield* inspectVolumeInfo(name);
      if (existing) {
        return toVolumeAttributes(existing);
      }
      yield* session.note(`Creating Docker volume: ${name}`);
      const createdName = yield* createVolume({
        name,
        driver: news?.driver ?? "local",
        driverOpts: news?.driverOpts,
        labels: normalizeLabels(news?.labels),
      });
      const info = yield* inspectVolumeInfo(createdName);
      if (!info) {
        return yield* Effect.die(
          `Docker volume was created but could not be inspected: ${createdName}`,
        );
      }
      return toVolumeAttributes(info);
    }),
    delete: Effect.fnUntraced(function* ({ output, session }) {
      yield* session.note(`Removing Docker volume: ${output.name}`);
      yield* removeVolume(output.name);
    }),
  });
