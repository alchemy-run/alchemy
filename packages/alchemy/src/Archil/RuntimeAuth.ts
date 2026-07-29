import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import type { RuntimeContext } from "../RuntimeContext.ts";
import {
  addDiskUser,
  createBranch,
  createDisk,
  deleteDisk,
  exec,
  execDisk,
  getDisk,
  grepDisk,
  listBranches,
  listCheckpoints,
  NoCheckpoint,
  removeDiskUser,
  type DiskStatus,
  type DiskUserSpec,
  type ExecMountSpec,
  type GrepRequest,
  type MountConfig,
} from "./Api.ts";
import type { DiskConnection, ExecMount } from "./Connect.ts";
import { Credentials } from "./Credentials.ts";
import { DEFAULT_REGION, type ArchilRegion } from "./Region.ts";

/**
 * Shared scaffolding for the Archil binding layers.
 *
 * The `*Http` layers mint a dedicated `Archil.ApiToken` per host and read it
 * back through the bound accessor at runtime; the `*Local` layers capture the
 * ambient deploy-time credentials. Both produce an {@link ArchilAuth} so every
 * layer shares the exact same client implementation.
 *
 * NOT exported from `index.ts`.
 */
export interface ArchilAuth {
  /** Provide credentials + HTTP client to a raw Archil API operation. */
  authorize: <A, E>(
    eff: Effect.Effect<A, E, Credentials | HttpClient.HttpClient>,
  ) => Effect.Effect<A, E, RuntimeContext>;
}

/**
 * Build an {@link ArchilAuth} from a bound token-value accessor (resolved
 * lazily so the secret is read from the host environment at runtime).
 */
export const authorizeWith = (
  value: Effect.Effect<Redacted.Redacted<string>>,
): ArchilAuth => ({
  authorize: (eff) =>
    value.pipe(
      Effect.flatMap((apiKey) =>
        eff.pipe(
          Effect.provide(
            Layer.succeed(
              Credentials,
              Effect.succeed({ apiKey, defaultRegion: DEFAULT_REGION }),
            ).pipe(Layer.provideMerge(FetchHttpClient.layer)),
          ),
        ),
      ),
    ),
});

/**
 * Disks report `creating` briefly after create; poll (bounded, ~20s max)
 * until `available` so a returned connection never races a half-provisioned
 * disk. A disk that is briefly invisible right after create counts as still
 * `creating`.
 */
const waitAvailable = (region: ArchilRegion, diskId: string) =>
  getDisk({ region, diskId }).pipe(
    Effect.map((d) => d.status),
    Effect.catchTag("DiskNotFound", () =>
      Effect.succeed("creating" as DiskStatus),
    ),
    Effect.repeat({
      until: (status: DiskStatus): boolean => status === "available",
      schedule: Schedule.exponential("200 millis", 1.5),
      times: 10,
    }),
    Effect.asVoid,
  );

/**
 * Fork a branch of `diskId`, shared by `Connect.fork` and the `Fork`
 * binding.
 *
 * Idempotent by branch name: an existing branch is returned as-is rather
 * than re-forked, so the per-user call is safe to make on every request.
 * With no explicit checkpoint the newest `committed` one is used — Archil
 * lists checkpoints oldest-first, so that is the last committed entry.
 */
export const forkBranch = (
  auth: ArchilAuth,
  id: Effect.Effect<string>,
  region: Effect.Effect<ArchilRegion>,
  name: string,
  options?: { from?: string; fromBranch?: string },
) =>
  Effect.gen(function* () {
    const currentRegion = yield* region;
    const diskId = yield* id;

    const existing = yield* auth.authorize(
      listBranches({ region: currentRegion, diskId }),
    );
    const already = existing.find((b) => b.branchName === name);
    if (already !== undefined) return already;

    const from =
      options?.from ??
      (yield* latestCheckpoint(
        auth,
        currentRegion,
        diskId,
        options?.fromBranch,
      ));
    return yield* auth.authorize(
      createBranch({
        region: currentRegion,
        diskId,
        branchName: name,
        fromCheckpoint: from,
        fromBranch: options?.fromBranch,
      }),
    );
  });

const latestCheckpoint = (
  auth: ArchilAuth,
  region: ArchilRegion,
  diskId: string,
  branch: string | undefined,
) =>
  Effect.gen(function* () {
    const checkpoints = yield* auth.authorize(
      listCheckpoints({ region, diskId, branch }),
    );
    const committed = checkpoints.filter((c) => c.status === "committed");
    const latest = committed[committed.length - 1];
    if (latest === undefined) {
      return yield* new NoCheckpoint({ diskId, branch });
    }
    return latest.checkpointName;
  });

/**
 * Build a {@link DiskConnection} over a resolved disk id + region. Derived
 * connections (`create`, `fork`, `open`) reuse the same auth and region, so
 * everything reachable from a bound disk stays inside its blast radius.
 */
export const makeConnection = (
  auth: ArchilAuth,
  id: Effect.Effect<string>,
  region: Effect.Effect<ArchilRegion>,
): DiskConnection => {
  const connection: DiskConnection = {
    id,
    exec: Effect.fn("Archil.Connect.exec")(function* (command: string) {
      return yield* auth.authorize(
        execDisk({ region: yield* region, diskId: yield* id, command }),
      );
    }),
    execWith: Effect.fn("Archil.Connect.execWith")(function* (request: {
      disks: Record<string, ExecMount>;
      command: string;
    }) {
      const disks: Record<string, string | ExecMountSpec> = {};
      for (const [path, mount] of Object.entries(request.disks)) {
        if (typeof mount === "string") {
          disks[path] = mount;
        } else if ("disk" in mount) {
          disks[path] = {
            disk:
              typeof mount.disk === "string"
                ? mount.disk
                : yield* mount.disk.id,
            subdirectory: mount.subdirectory,
            readOnly: mount.readOnly,
          };
        } else {
          disks[path] = yield* mount.id;
        }
      }
      return yield* auth.authorize(
        exec({ region: yield* region, disks, command: request.command }),
      );
    }),
    grep: Effect.fn("Archil.Connect.grep")(function* (request: GrepRequest) {
      return yield* auth.authorize(
        grepDisk({ region: yield* region, diskId: yield* id, ...request }),
      );
    }),
    info: Effect.fn("Archil.Connect.info")(function* () {
      return yield* auth.authorize(
        getDisk({ region: yield* region, diskId: yield* id }),
      );
    }),
    delete: Effect.fn("Archil.Connect.delete")(function* () {
      yield* auth
        .authorize(deleteDisk({ region: yield* region, diskId: yield* id }))
        .pipe(Effect.catchTag("DiskNotFound", () => Effect.void));
    }),
    addUser: Effect.fn("Archil.Connect.addUser")(function* (
      user: DiskUserSpec,
    ) {
      return yield* auth.authorize(
        addDiskUser({ region: yield* region, diskId: yield* id, user }),
      );
    }),
    removeUser: Effect.fn("Archil.Connect.removeUser")(function* (input: {
      type: "token" | "awssts";
      identifier?: string;
    }) {
      yield* auth.authorize(
        removeDiskUser({
          region: yield* region,
          diskId: yield* id,
          userType: input.type,
          identifier: input.identifier,
        }),
      );
    }),
    create: Effect.fn("Archil.Connect.create")(function* (
      name: string,
      options?: { mounts?: MountConfig[] },
    ) {
      const currentRegion = yield* region;
      const created = yield* auth.authorize(
        createDisk({ region: currentRegion, name, mounts: options?.mounts }),
      );
      yield* auth.authorize(waitAvailable(currentRegion, created.diskId));
      const tokenUser = created.authorizedUsers?.find(
        (u) => u.token !== undefined,
      );
      return {
        disk: makeConnection(
          auth,
          Effect.succeed(created.diskId),
          Effect.succeed(currentRegion),
        ),
        diskId: created.diskId,
        diskToken: tokenUser?.token
          ? Redacted.make(tokenUser.token)
          : undefined,
      };
    }),
    fork: Effect.fn("Archil.Connect.fork")(function* (
      name: string,
      options?: { from?: string; fromBranch?: string },
    ) {
      const currentRegion = yield* region;
      const branch = yield* forkBranch(auth, id, region, name, options);
      return {
        // A branch carries its own filesystem id, so it is addressed like
        // any other disk.
        disk: makeConnection(
          auth,
          Effect.succeed(branch.filesystemId),
          Effect.succeed(currentRegion),
        ),
        branch,
      };
    }),
    checkpoints: Effect.fn("Archil.Connect.checkpoints")(function* (options?: {
      branch?: string;
    }) {
      return yield* auth.authorize(
        listCheckpoints({
          region: yield* region,
          diskId: yield* id,
          branch: options?.branch,
        }),
      );
    }),
    branches: Effect.fn("Archil.Connect.branches")(function* () {
      return yield* auth.authorize(
        listBranches({ region: yield* region, diskId: yield* id }),
      );
    }),
    open: (diskId: string) =>
      makeConnection(auth, Effect.succeed(diskId), region),
  };
  return connection;
};
