import * as archil from "@distilled.cloud/archil";
import { Unowned } from "alchemy/AdoptPolicy";
import { deepEqual, isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import {
  diskName,
  findDiskByName,
  getDisk,
  isAlchemyName,
  isRuntimeObjectName,
  waitForDisk,
  waitForDiskGone,
  listAllDisks,
} from "./internal/archil.ts";
import type { Providers } from "./Providers.ts";

/**
 * Amazon S3 bucket behind a disk. Omit the keys when the bucket policy
 * trusts Archil's role for the region (see `ArchilAWS.S3Disk`, which writes
 * that policy for you).
 */
export interface S3DiskStorage {
  type: "s3";
  /** Bucket name. */
  bucketName: string;
  /** Prefix within the bucket the disk lives under, e.g. `"data/"`. */
  bucketPrefix?: string;
  /** Access key id. Omit for IAM-role access through the bucket policy. */
  accessKeyId?: Redacted.Redacted<string>;
  /** Secret access key. */
  secretAccessKey?: Redacted.Redacted<string>;
  /** Session token for temporary credentials. */
  sessionToken?: Redacted.Redacted<string>;
}

/** Google Cloud Storage bucket behind a disk, through HMAC keys. */
export interface GcsDiskStorage {
  type: "gcs";
  bucketName: string;
  bucketPrefix?: string;
  accessKeyId: Redacted.Redacted<string>;
  secretAccessKey: Redacted.Redacted<string>;
}

/** Cloudflare R2 bucket behind a disk. */
export interface R2DiskStorage {
  type: "r2";
  bucketName: string;
  /** R2 S3 endpoint, `https://<account>.r2.cloudflarestorage.com`. */
  bucketEndpoint: string;
  bucketPrefix?: string;
  accessKeyId: Redacted.Redacted<string>;
  secretAccessKey: Redacted.Redacted<string>;
}

/** Any S3-compatible object store behind a disk. */
export interface S3CompatibleDiskStorage {
  type: "s3-compatible";
  bucketName: string;
  bucketEndpoint: string;
  bucketPrefix?: string;
  accessKeyId: Redacted.Redacted<string>;
  secretAccessKey: Redacted.Redacted<string>;
}

/** Azure Blob Storage container behind a disk, through a service principal. */
export interface AzureBlobDiskStorage {
  type: "azure-blob";
  storageAccount: string;
  containerName: string;
  bucketPrefix?: string;
  tenantId: string;
  clientId: string;
  clientSecret: Redacted.Redacted<string>;
}

/** Where a disk's files live. Omit for Archil-managed storage. */
export type DiskStorage =
  | S3DiskStorage
  | GcsDiskStorage
  | R2DiskStorage
  | S3CompatibleDiskStorage
  | AzureBlobDiskStorage;

export interface DiskProps {
  /**
   * Disk name, unique within your Archil account: letters, digits, `-` and
   * `_`, at most 100 characters. If omitted, a unique name is generated
   * from the stack, stage, and logical ID. Changing it replaces the disk.
   */
  name?: string;
  /**
   * Your own bucket to keep the disk's files in, as ordinary objects any
   * S3 tool can read. Omit for Archil-managed storage. Changing it replaces
   * the disk.
   */
  storage?: DiskStorage;
  /**
   * IPv4 addresses and CIDR ranges allowed to mount the disk. Empty or
   * omitted allows any address.
   */
  allowedIps?: string[];
  /**
   * Whether sandboxes and serverless exec may mount the disk.
   * @default true
   */
  allowSandboxMount?: boolean;
}

export interface DiskAttributes {
  /** Disk id (`dsk-…`). */
  diskId: string;
  /** Disk name. */
  name: string;
  /** Archil organization that owns the disk. */
  organization: string;
  /** Archil region the disk lives in, e.g. `aws-us-east-1`. */
  region: string;
  /** Storage backend: `archil` for Archil-managed storage, else the bucket type. */
  storageType: string;
  /** Bucket name, for a disk on your own bucket. */
  bucketName: string | undefined;
  /** Bucket prefix, for a disk on your own bucket. */
  bucketPrefix: string | undefined;
  /**
   * The session id Archil assumes your bucket's role with. Bucket policies
   * can scope access to exactly this disk with
   * `aws:PrincipalTag/archilSessionId`.
   */
  sessionId: string | undefined;
  /** IPv4 addresses and CIDR ranges allowed to mount the disk. */
  allowedIps: string[];
  /** Whether sandboxes and serverless exec may mount the disk. */
  allowSandboxMount: boolean;
}

export type Disk = Resource<"Archil.Disk", DiskProps, DiskAttributes, never, Providers, DiskLookup>;

/**
 * Props for {@link Disk.lookup}: find a disk this stack
 * doesn't manage by its name.
 */
export interface DiskLookup {
  /** Disk name. */
  name: string;
}

/**
 * An Archil disk: a durable filesystem that mounts in about 50 ms on any
 * Linux machine, sandbox, or serverless exec, with hot data on SSD and the
 * rest in object storage. Keep its files in Archil-managed storage, or in
 * your own bucket as ordinary objects.
 *
 * Declare a disk at deploy time for the few long-lived ones an app shares,
 * like a dataset or a seeded base you branch from. Disks that belong to one
 * user, session, or task are created at run time with
 * {@link CreateDisk}, which returns the same disk shape.
 *
 * Archil has no tags, so Alchemy owns a disk through its generated name.
 * A disk with a fixed `name` that already exists is adopted only with
 * `--adopt`.
 *
 * :::caution
 * Changing `name` or `storage` replaces the disk, and destroying a disk on
 * Archil-managed storage deletes its files. A disk on your own bucket
 * leaves the objects in the bucket.
 * :::
 * @see https://docs.archil.com
 *
 * ### Creating a Disk
 * **Example:** Archil-managed storage
 * ```typescript
 * export const Dataset = Archil.Disk("Dataset", {});
 * ```
 *
 * **Example:** On your own S3 bucket, with no keys
 * ```typescript
 * export const Store = AWS.S3.Bucket("Store", {});
 * export const Dataset = ArchilAWS.S3Disk("Dataset", { bucket: Store, prefix: "datasets/" });
 * ```
 *
 * **Example:** On an R2 bucket
 * ```typescript
 * export const Dataset = Archil.Disk("Dataset", {
 *   storage: {
 *     type: "r2",
 *     bucketName: "datasets",
 *     bucketEndpoint: "https://<account>.r2.cloudflarestorage.com",
 *     accessKeyId: Alchemy.Secret("R2_ACCESS_KEY_ID"),
 *     secretAccessKey: Alchemy.Secret("R2_SECRET_ACCESS_KEY"),
 *   },
 * });
 * ```
 *
 * ### Restricting Access
 * **Example:** Only mount from known addresses
 * ```typescript
 * export const Dataset = Archil.Disk("Dataset", {
 *   allowedIps: ["203.0.113.0/24"],
 *   allowSandboxMount: false,
 * });
 * ```
 *
 * ### Binding to a Runtime
 * Object bindings give each host its own S3 user on this disk (read-only
 * for `ReadDisk`), so the host never holds an API key.
 *
 * **Example:** Read and write the disk from a program sandbox
 * ```typescript
 * export default class Api extends Archil.Sandbox<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const files = yield* Archil.ReadWriteDisk(Dataset);
 *     return {
 *       fetch: Effect.map(files.getText("README.md"), (text) => HttpServerResponse.text(text)),
 *     };
 *   }).pipe(Effect.provide(Archil.ReadWriteDiskHttp)),
 * ) {}
 * ```
 *
 * **Example:** Mount it into a sandbox
 * ```typescript
 * export const Box = Archil.Sandbox("Box", {
 *   mounts: [{ disk: Dataset, path: "/data", mode: "read-only" }],
 * });
 * ```
 *
 * **Example:** Mount it in a Cloudflare Container
 * ```typescript
 * const dataset = yield* Archil.MountDisk(Dataset, { path: "/data", mode: "read-only" });
 * const path = yield* dataset.mount();
 * ```
 *
 * ### Runtime Operations
 * **Example:** Run commands and read files
 * ```typescript
 * const dataset = yield* Archil.ExecDisk(Dataset);
 * const files = yield* Archil.ReadDisk(Dataset);
 * const result = yield* dataset.exec("wc -l /mnt/archil/*.csv");
 * const readme = yield* files.getText("README.md");
 * ```
 *
 * **Example:** Upload a large file and share a link
 * ```typescript
 * const files = yield* Archil.ReadWriteDisk(Dataset);
 * yield* files.upload("exports/2026-11.parquet", body);
 * const url = yield* files.share("exports/2026-11.parquet", 3600);
 * ```
 *
 * ### Branches and Checkpoints
 * **Example:** Seed a base, then branch per session
 * ```typescript
 * export const Seed = Archil.Disk("Seed", {});
 * export const SeedBase = Effect.gen(function* () {
 *   const seed = yield* Seed;
 *   return yield* Archil.Checkpoint("SeedBase", {
 *     disk: seed.diskId,
 *     name: "base",
 *     run: ["git clone https://github.com/acme/app ."],
 *   });
 * });
 * // runtime
 * const seeds = yield* Archil.BranchDisk(Seed);
 * const branch = yield* seeds.branch({ name: `session-${id}`, fromCheckpoint: "base" });
 * ```
 *
 * ### Looking up an existing disk
 * `Disk.lookup` references a disk Alchemy doesn't manage (created in
 * the Archil console or by another stack). It is read during plan/deploy,
 * never created, updated or deleted.
 *
 * **Example:** Branch an existing disk
 * ```typescript
 * const data = Archil.Disk.lookup({ name: "datasets" });
 * const preview = yield* Archil.Branch("Preview", { disk: data.diskId });
 * ```
 *
 * @resource
 * @product Disk
 */
export const Disk = Resource<Disk>("Archil.Disk");

const unwrap = (value: Redacted.Redacted<string> | string | undefined) =>
  value === undefined ? undefined : typeof value === "string" ? value : Redacted.value(value);

/** The `mounts` entry Archil's create call takes for a storage backend. */
export const toMountConfig = (storage: DiskStorage): archil.MountConfig => {
  switch (storage.type) {
    case "s3":
      return {
        type: "s3",
        bucketName: storage.bucketName,
        bucketPrefix: storage.bucketPrefix,
        accessKeyId: unwrap(storage.accessKeyId),
        secretAccessKey: unwrap(storage.secretAccessKey),
        sessionToken: unwrap(storage.sessionToken),
      } as archil.MountConfig;
    case "gcs":
    case "r2":
    case "s3-compatible":
      return {
        ...storage,
        accessKeyId: unwrap(storage.accessKeyId),
        secretAccessKey: unwrap(storage.secretAccessKey),
      } as archil.MountConfig;
    case "azure-blob":
      return { ...storage, clientSecret: unwrap(storage.clientSecret) } as archil.MountConfig;
  }
};

/** The comparable identity of a storage backend (no secrets). */
const storageIdentity = (storage: DiskStorage | undefined) =>
  storage === undefined
    ? undefined
    : {
        type: storage.type,
        bucketName: "bucketName" in storage ? storage.bucketName : undefined,
        bucketPrefix: storage.bucketPrefix,
        bucketEndpoint: "bucketEndpoint" in storage ? storage.bucketEndpoint : undefined,
        containerName: "containerName" in storage ? storage.containerName : undefined,
        storageAccount: "storageAccount" in storage ? storage.storageAccount : undefined,
      };

/** Map a disk response (and its synced settings) to attributes. */
export const toDiskAttributes = (
  disk: archil.DiskResponse,
  settings: { allowedIps: string[]; allowSandboxMount: boolean },
): DiskAttributes => {
  const first = disk.mounts?.[0];
  // Archil-managed storage is an `s3` mount on Archil's own bucket.
  const mount = first?.config?.bucketName?.startsWith("archil.prod.") ? undefined : first;
  return {
    diskId: disk.id,
    name: disk.name,
    organization: disk.organization,
    region: disk.region,
    storageType: mount?.type ?? "archil",
    bucketName: mount?.config?.bucketName,
    bucketPrefix: mount?.config?.bucketPrefix,
    sessionId: mount?.config?.sessionId,
    allowedIps: settings.allowedIps,
    allowSandboxMount: settings.allowSandboxMount,
  };
};

/** Read a disk's mount-access settings. */
export const readDiskSettings = Effect.fn(function* (id: string) {
  const [ips, mount] = yield* Effect.all(
    [archil.getAllowedIps({ id }), archil.getSandboxMount({ id })],
    { concurrency: 2 },
  );
  return {
    allowedIps: ips.data.allowedIps ?? [],
    allowSandboxMount: mount.data.allowSandboxMount,
  };
});

/** Converge a disk's mount-access settings to the desired ones. */
export const syncDiskSettings = Effect.fn(function* (
  id: string,
  desired: { allowedIps?: string[]; allowSandboxMount?: boolean },
) {
  const observed = yield* readDiskSettings(id);
  const allowedIps = desired.allowedIps ?? [];
  const allowSandboxMount = desired.allowSandboxMount ?? true;
  if (!deepEqual([...observed.allowedIps].sort(), [...allowedIps].sort())) {
    yield* archil.setAllowedIps({ id, allowedIps });
  }
  if (observed.allowSandboxMount !== allowSandboxMount) {
    yield* archil.setSandboxMount({ id, allowSandboxMount });
  }
  return { allowedIps, allowSandboxMount };
});

/** Ensure a disk with this name exists and is available (create-or-observe). */
export const ensureDisk = Effect.fn(function* (
  name: string,
  storage: DiskStorage | undefined,
  knownId?: string,
) {
  const found = (knownId ? yield* getDisk(knownId) : undefined) ?? (yield* findDiskByName(name));
  // A disk still being deleted (an earlier destroy) holds the name: let it go.
  if (found?.status === "deleting") yield* waitForDiskGone(found.id);
  const observed = found?.status === "deleting" ? undefined : found;
  if (observed) return yield* waitForDisk(observed.id);
  // Archil answers a create of an existing name with that disk's id, so a
  // concurrent create of the same name needs no special case.
  const { data } = yield* archil.createDisk({
    name,
    mounts: storage ? [toMountConfig(storage)] : undefined,
  });
  return yield* waitForDisk(data.diskId);
});

/** Delete a disk and wait until it is gone. Deleting a missing disk succeeds. */
export const deleteDisk = Effect.fn(function* (id: string) {
  yield* archil.deleteDisk({ id }).pipe(Effect.catchTag("NotFound", () => Effect.void));
  yield* waitForDiskGone(id);
});

export const DiskProvider = () =>
  Provider.effect(
    Disk,
    Effect.gen(function* () {
      return {
        stables: ["diskId", "name", "organization", "region", "storageType"],
        list: Effect.fn(function* () {
          const disks = yield* Stream.runCollect(listAllDisks());
          return yield* Effect.forEach(
            disks.filter(
              (disk) =>
                (isAlchemyName(disk.name) || isRuntimeObjectName(disk.name)) &&
                disk.status !== "deleted",
            ),
            (disk) => readDiskSettings(disk.id).pipe(Effect.map((s) => toDiskAttributes(disk, s))),
            { concurrency: 4 },
          );
        }),
        diff: Effect.fn(function* ({ id, olds, news, output }) {
          if (!isResolved(news)) return undefined;
          const name = output?.name ?? (yield* diskName(id, olds?.name));
          if (news.name !== undefined && news.name !== name) {
            return { action: "replace" } as const;
          }
          if (!deepEqual(storageIdentity(news.storage), storageIdentity(olds?.storage))) {
            return { action: "replace" } as const;
          }
          return undefined;
        }),
        lookup: Effect.fn(function* ({ name }) {
          const disk = yield* findDiskByName(name);
          return disk ? toDiskAttributes(disk, yield* readDiskSettings(disk.id)) : undefined;
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const name = output?.name ?? (yield* diskName(id, olds?.name));
          const disk =
            (output ? yield* getDisk(output.diskId) : undefined) ?? (yield* findDiskByName(name));
          if (!disk) return undefined;
          const attrs = toDiskAttributes(disk, yield* readDiskSettings(disk.id));
          // A generated name carries this resource's instance suffix, so a
          // disk with that name is ours even when state was lost. A fixed
          // name may belong to anyone.
          if (output === undefined && olds?.name !== undefined && !isAlchemyName(disk.name)) {
            return Unowned(attrs);
          }
          return attrs;
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          // Observe + ensure
          const name = output?.name ?? (yield* diskName(id, news.name));
          yield* session.note(`Ensuring disk ${name}...`);
          const disk = yield* ensureDisk(name, news.storage, output?.diskId);
          // Sync
          const settings = yield* syncDiskSettings(disk.id, news);
          return toDiskAttributes(disk, settings);
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* deleteDisk(output.diskId);
        }),
      };
    }),
  );
