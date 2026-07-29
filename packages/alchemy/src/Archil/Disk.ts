import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { isResolved } from "../Diff.ts";
import { createPhysicalName } from "../PhysicalName.ts";
import * as Provider from "../Provider.ts";
import { isResourceOfType, Resource } from "../Resource.ts";
import {
  createDisk,
  deleteDisk,
  getDisk,
  listDisks,
  retryTransient,
  type DiskData,
  type DiskStatus,
  type MountConfig,
} from "./Api.ts";
import { Credentials } from "./Credentials.ts";
import { ALL_REGIONS, endpointForRegion, type ArchilRegion } from "./Region.ts";
import type { Providers } from "./Providers.ts";

export type { MountConfig } from "./Api.ts";

export interface DiskProps {
  /**
   * Disk name (alphanumeric, dashes, underscores; 1-100 characters).
   * If omitted, a unique name is generated from `${app}-${stage}-${id}`.
   * Changing the name replaces the disk.
   */
  name?: string;
  /**
   * Region the disk lives in. Serverless execution (`exec`/`grep`) is only
   * available in the AWS regions; storage works everywhere. Changing the
   * region replaces the disk.
   *
   * @default the credentials' default region (`ARCHIL_REGION` or "aws-us-east-1")
   */
  region?: ArchilRegion;
  /**
   * Storage backend (S3, GCS, R2, S3-compatible, or Azure Blob) to sync the
   * disk with. Omit for archil-managed storage. Changing the mount replaces
   * the disk.
   */
  mount?: MountConfig;
}

export type Disk = Resource<
  "Archil.Disk",
  DiskProps,
  {
    /** Disk ID (`dsk-{16 hex chars}`). */
    diskId: string;
    /** Disk name. */
    name: string;
    /** Region the disk lives in. */
    region: ArchilRegion;
    /** Control-plane endpoint for the disk's region. */
    endpoint: string;
    /** Disk status. */
    status: DiskStatus;
    /** Cloud provider backing the region (e.g. "aws"). */
    provider: string;
    /** Creation timestamp. */
    createdAt: string;
    /**
     * The auto-generated disk token used by clients when mounting the disk
     * (e.g. `archil mount`, the CSI driver, or the `disk` SDK). Captured
     * exactly once at creation — Archil never returns it again — and absent
     * on adopted disks.
     */
    diskToken: Redacted.Redacted<string> | undefined;
    /** Last 4 characters of the disk token. */
    diskTokenSuffix: string | undefined;
  },
  never,
  Providers
>;

type DiskAttributes = Disk["Attributes"];

/** Disk did not reach `available` within the bounded provisioning wait. */
export class DiskNotReady extends Data.TaggedError("DiskNotReady")<{
  diskId: string;
  status: DiskStatus;
}> {}

/**
 * An Archil disk — an elastic, infinitely-scalable file system that spins up
 * in milliseconds and only bills for data you actually store. Disks can be
 * mounted on servers (NFS/FUSE/CSI), synced with object storage, and — in
 * AWS regions — targeted by serverless execution to run bash commands
 * without provisioning any compute.
 *
 * @resource
 * @section Creating a Disk
 * @example Basic disk
 * ```typescript
 * const disk = yield* Archil.Disk("scratch");
 * ```
 *
 * @example Disk in an explicit region
 * ```typescript
 * const disk = yield* Archil.Disk("scratch", {
 *   region: "aws-us-west-2",
 * });
 * ```
 *
 * @example Disk synced with an S3 bucket
 * ```typescript
 * const disk = yield* Archil.Disk("data", {
 *   mount: {
 *     type: "s3",
 *     bucketName: "my-bucket",
 *     bucketPrefix: "datasets/",
 *   },
 * });
 * ```
 *
 * @example Disk synced with a Cloudflare R2 bucket
 * ```typescript
 * const disk = yield* Archil.Disk("r2-data", {
 *   mount: {
 *     type: "r2",
 *     bucketName: "my-r2-bucket",
 *     bucketEndpoint: "https://accountid.r2.cloudflarestorage.com",
 *     accessKeyId: "...",
 *     secretAccessKey: "...",
 *   },
 * });
 * ```
 *
 * @section Running Commands on a Disk
 * @example Execute bash from a Function or Worker
 * Bind {@link Connect} to run shell commands in an ephemeral container with
 * the disk mounted at `/mnt/archil` — a real OS with coreutils, python3,
 * and node, billed per millisecond of execution.
 * ```typescript
 * const data = yield* Archil.Connect(DataDisk);
 *
 * const { stdout, exitCode } = yield* data.exec(
 *   "wc -l /mnt/archil/data/*.csv",
 * );
 * ```
 *
 * @example Derive a disk per user or thread
 * Everything dynamic hangs off a bound disk — `create` for an empty
 * sibling, `fork` for a copy-on-write branch of a checkpoint.
 * ```typescript
 * const { disk: workspace } = yield* data.create(`thread-${threadId}`);
 * yield* workspace.exec("python3 /mnt/archil/run.py");
 * ```
 *
 * @section Mounting Elsewhere
 * @example Use the disk token to mount on a server
 * ```typescript
 * const disk = yield* Archil.Disk("shared");
 * // disk.diskToken is the per-disk mount credential (captured once at
 * // creation); hand it to `archil mount` / the CSI driver out-of-band.
 * return { diskId: disk.diskId };
 * ```
 *
 * @see https://docs.archil.com/getting-started/introduction
 */
export const Disk = Resource<Disk>("Archil.Disk");

export const isDisk = <T>(value: T): value is T & Disk =>
  isResourceOfType(value, "Archil.Disk");

const toAttributes = (
  disk: DiskData,
  region: ArchilRegion,
  tokens: {
    diskToken?: Redacted.Redacted<string>;
    diskTokenSuffix?: string;
  },
): DiskAttributes => ({
  diskId: disk.id,
  name: disk.name,
  region,
  endpoint: endpointForRegion(region),
  status: disk.status,
  provider: disk.provider,
  createdAt: disk.createdAt,
  diskToken: tokens.diskToken,
  diskTokenSuffix: tokens.diskTokenSuffix,
});

const resolveName = (id: string, name: string | undefined) =>
  Effect.gen(function* () {
    return name ?? (yield* createPhysicalName({ id }));
  });

const findDiskByName = (region: ArchilRegion, name: string) =>
  listDisks({ region, name, limit: 100 }).pipe(
    retryTransient,
    Effect.map((disks) => disks.find((d) => d.name === name)),
  );

/**
 * Disks report `creating` briefly after create; poll (bounded, ~20s max)
 * until `available` so downstream exec/mount consumers never race a
 * half-provisioned disk.
 */
const waitForAvailable = (region: ArchilRegion, diskId: string) =>
  Effect.gen(function* () {
    const disk = yield* getDisk({ region, diskId }).pipe(
      retryTransient,
      Effect.repeat({
        until: (d: DiskData): boolean =>
          d.status === "available" || d.status === "failed",
        schedule: Schedule.exponential("200 millis", 1.5),
        times: 10,
      }),
    );
    if (disk.status !== "available") {
      return yield* new DiskNotReady({ diskId, status: disk.status });
    }
    return disk;
  });

const mountFingerprint = (mount: MountConfig | undefined): string =>
  JSON.stringify(mount ?? null);

export const DiskProvider = () =>
  Provider.succeed(Disk, {
    stables: ["diskId", "region", "endpoint", "provider", "createdAt"],
    list: Effect.fn(function* () {
      // Disks are regional; enumerate every region, skipping regions the
      // account has no access to (preview regions return 403).
      const rows = yield* Effect.forEach(
        ALL_REGIONS,
        (region) =>
          listDisks({ region, limit: 100 }).pipe(
            retryTransient,
            Effect.map((disks) =>
              disks.map((disk) => toAttributes(disk, region, {})),
            ),
            Effect.catchTag("AccessDenied", () => Effect.succeed([])),
          ),
        { concurrency: ALL_REGIONS.length },
      );
      return rows.flat();
    }),
    diff: Effect.fn(function* ({ id, olds = {}, news = {}, output }) {
      if (!isResolved(news)) return undefined;
      // Auto-generated names are engine-owned: only an explicit
      // user-provided name can force a replace.
      const oldName = output?.name ?? (yield* resolveName(id, olds.name));
      const newName = news.name ?? oldName;
      if (newName !== oldName) {
        return { action: "replace" } as const;
      }
      const { defaultRegion } = yield* yield* Credentials;
      const oldRegion = output?.region ?? olds.region ?? defaultRegion;
      if ((news.region ?? oldRegion) !== oldRegion) {
        return { action: "replace" } as const;
      }
      // There is no update API: a mount change is a replacement.
      if (mountFingerprint(news.mount) !== mountFingerprint(olds.mount)) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),
    read: Effect.fn(function* ({ id, output, olds }) {
      if (output?.diskId) {
        return yield* getDisk({
          region: output.region,
          diskId: output.diskId,
        }).pipe(
          Effect.map((disk) =>
            toAttributes(disk, output.region, {
              diskToken: output.diskToken,
              diskTokenSuffix: output.diskTokenSuffix,
            }),
          ),
          Effect.catchTag("DiskNotFound", () => Effect.succeed(undefined)),
        );
      }
      const { defaultRegion } = yield* yield* Credentials;
      const region = olds?.region ?? defaultRegion;
      const name = yield* resolveName(id, olds?.name);
      const match = yield* findDiskByName(region, name);
      return match ? toAttributes(match, region, {}) : undefined;
    }),
    reconcile: Effect.fn(function* ({ id, news = {}, output }) {
      const { defaultRegion } = yield* yield* Credentials;
      const region = news.region ?? output?.region ?? defaultRegion;
      const name =
        news.name ?? output?.name ?? (yield* resolveName(id, undefined));

      // Observe — cloud state is authoritative; `output` is only a cache of
      // the disk id.
      const observed = output?.diskId
        ? yield* getDisk({ region, diskId: output.diskId }).pipe(
            retryTransient,
            Effect.catchTag("DiskNotFound", () => Effect.succeed(undefined)),
          )
        : yield* findDiskByName(region, name);

      // Ensure — create if missing. Archil's create is idempotent by name
      // (200 when an identical disk already exists), which also absorbs
      // create races. The one-time disk token only appears on a fresh
      // create.
      if (observed === undefined) {
        const created = yield* createDisk({
          region,
          name,
          mounts: news.mount ? [news.mount] : undefined,
        }).pipe(retryTransient);
        const tokenUser = created.authorizedUsers?.find(
          (u) => u.token !== undefined,
        );
        const disk = yield* waitForAvailable(region, created.diskId);
        return toAttributes(disk, region, {
          diskToken: tokenUser?.token
            ? Redacted.make(tokenUser.token)
            : undefined,
          diskTokenSuffix: tokenUser?.tokenSuffix,
        });
      }

      // Sync — nothing is mutable in place (name/region/mount changes are
      // replacements via diff); just settle to `available` and preserve the
      // one-time disk token captured at creation.
      const disk = yield* waitForAvailable(region, observed.id);
      return toAttributes(disk, region, {
        diskToken: output?.diskToken,
        diskTokenSuffix: output?.diskTokenSuffix,
      });
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* deleteDisk({
        region: output.region,
        diskId: output.diskId,
      }).pipe(
        retryTransient,
        Effect.catchTag("DiskNotFound", () => Effect.void),
      );
      // Deletion is asynchronous server-side; wait (bounded, ~25s) until the
      // disk is actually gone so a same-name recreate can't collide.
      yield* getDisk({ region: output.region, diskId: output.diskId }).pipe(
        Effect.map((d) => d.status),
        Effect.catchTag("DiskNotFound", () =>
          Effect.succeed("deleted" as DiskStatus),
        ),
        retryTransient,
        Effect.repeat({
          until: (status: DiskStatus): boolean => status === "deleted",
          schedule: Schedule.exponential("250 millis", 1.5),
          times: 10,
        }),
        Effect.asVoid,
      );
    }),
  });
