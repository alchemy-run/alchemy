import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import type { RuntimeContext } from "../RuntimeContext.ts";
import {
  createDisk,
  deleteDisk,
  exec,
  execDisk,
  getDisk,
  grepDisk,
  listDisks,
  removeDiskUser,
  addDiskUser,
  type DiskStatus,
  type DiskUserSpec,
  type ExecMountSpec,
  type GrepRequest,
  type MountConfig,
} from "./Api.ts";
import type {
  ArchilClient,
  ClientExecRequest,
  DiskClient,
  DiskRefOptions,
} from "./Client.ts";
import { Credentials } from "./Credentials.ts";
import { DEFAULT_REGION, type ArchilRegion } from "./Region.ts";

/**
 * Shared scaffolding for the Archil {@link Client} binding layers.
 *
 * `ClientHttp` mints a dedicated `Archil.ApiToken` per host and reads it
 * back through the bound accessor at runtime; `ClientLocal` captures the
 * ambient deploy-time credentials. Both produce an {@link ArchilAuth} so the
 * layers share the exact same {@link makeArchilClient} implementation.
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
 * until `available` so the returned handle never races a half-provisioned
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

/** Build the {@link ArchilClient} shared by the Http and Local layers. */
export const makeArchilClient = (
  auth: ArchilAuth,
  clientRegion: Effect.Effect<ArchilRegion>,
): ArchilClient => {
  const regionOf = (options?: DiskRefOptions): Effect.Effect<ArchilRegion> =>
    options?.region === undefined
      ? clientRegion
      : Effect.isEffect(options.region)
        ? options.region
        : Effect.succeed(options.region);

  const makeDisk = (
    id: Effect.Effect<string>,
    region: Effect.Effect<ArchilRegion>,
  ): DiskClient => ({
    id,
    region,
    exec: Effect.fn("Archil.Client.disk.exec")(function* (command: string) {
      return yield* auth.authorize(
        execDisk({ region: yield* region, diskId: yield* id, command }),
      );
    }),
    grep: Effect.fn("Archil.Client.disk.grep")(function* (
      request: GrepRequest,
    ) {
      return yield* auth.authorize(
        grepDisk({ region: yield* region, diskId: yield* id, ...request }),
      );
    }),
    get: Effect.fn("Archil.Client.disk.get")(function* () {
      return yield* auth.authorize(
        getDisk({ region: yield* region, diskId: yield* id }),
      );
    }),
    delete: Effect.fn("Archil.Client.disk.delete")(function* () {
      yield* auth
        .authorize(deleteDisk({ region: yield* region, diskId: yield* id }))
        .pipe(Effect.catchTag("DiskNotFound", () => Effect.void));
    }),
    addUser: Effect.fn("Archil.Client.disk.addUser")(function* (
      user: DiskUserSpec,
    ) {
      return yield* auth.authorize(
        addDiskUser({ region: yield* region, diskId: yield* id, user }),
      );
    }),
    removeUser: Effect.fn("Archil.Client.disk.removeUser")(function* (input: {
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
  });

  return {
    disk: (id, options) =>
      makeDisk(
        typeof id === "string" ? Effect.succeed(id) : id,
        regionOf(options),
      ),
    listDisks: Effect.fn("Archil.Client.listDisks")(function* (options?: {
      name?: string;
      limit?: number;
      cursor?: string;
    }) {
      return yield* auth.authorize(
        listDisks({ region: yield* clientRegion, ...options }),
      );
    }),
    createDisk: Effect.fn("Archil.Client.createDisk")(function* (options: {
      name: string;
      mounts?: MountConfig[];
    }) {
      const region = yield* clientRegion;
      const created = yield* auth.authorize(
        createDisk({ region, name: options.name, mounts: options.mounts }),
      );
      yield* auth.authorize(waitAvailable(region, created.diskId));
      const tokenUser = created.authorizedUsers?.find(
        (u) => u.token !== undefined,
      );
      return {
        disk: makeDisk(Effect.succeed(created.diskId), Effect.succeed(region)),
        diskId: created.diskId,
        diskToken: tokenUser?.token
          ? Redacted.make(tokenUser.token)
          : undefined,
      };
    }),
    getDisk: Effect.fn("Archil.Client.getDisk")(function* (id: string) {
      return yield* auth.authorize(
        getDisk({ region: yield* clientRegion, diskId: id }),
      );
    }),
    deleteDisk: Effect.fn("Archil.Client.deleteDisk")(function* (id: string) {
      yield* auth
        .authorize(deleteDisk({ region: yield* clientRegion, diskId: id }))
        .pipe(Effect.catchTag("DiskNotFound", () => Effect.void));
    }),
    exec: Effect.fn("Archil.Client.exec")(function* (
      request: ClientExecRequest,
    ) {
      const region = yield* clientRegion;
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
        exec({ region, disks, command: request.command }),
      );
    }),
  };
};
