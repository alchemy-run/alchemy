import * as archil from "@distilled.cloud/archil";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { ApiAccess, runtimeName, runtimePrefix } from "./ArchilBindings.ts";
import { makeDiskHandle, type DiskHandle } from "./Clients.ts";
import { deleteDisk, ensureDisk, type DiskStorage } from "./Disk.ts";
import type { ArchilFailed, ArchilNotReady } from "./internal/archil.ts";
import { findDiskByName, listAllDisks } from "./internal/archil.ts";

export interface CreateDiskOptions {
  /**
   * Where disks created by this client keep their files. Omit for
   * Archil-managed storage. A run-time `create` can override it.
   */
  storage?: DiskStorage;
}

export type CreateDiskError =
  | archil.CreateDiskError
  | archil.GetDiskError
  | archil.ListDisksError
  | ArchilFailed
  | ArchilNotReady;

export interface CreateDiskClient {
  /**
   * The name prefix this client puts on everything it creates,
   * `alc-<id>-<hash of stack/stage/id>`.
   */
  readonly prefix: string;
  /**
   * Create a disk (or return the one that already has this name). Names
   * are stamped with this binding's prefix, so `create({ name: "user-1" })`
   * is the same disk on every call.
   */
  create(
    name: string,
    options?: { readonly storage?: DiskStorage },
  ): Effect.Effect<DiskHandle, CreateDiskError, RuntimeContext>;
  /** A disk this client created, or `undefined`. */
  get(name: string): Effect.Effect<DiskHandle | undefined, archil.ListDisksError, RuntimeContext>;
  /** Every disk this client created. */
  list(): Effect.Effect<DiskHandle[], archil.ListDisksError, RuntimeContext>;
  /** Delete a disk this client created. Deleting a missing disk succeeds. */
  delete(
    name: string,
  ): Effect.Effect<
    void,
    archil.ListDisksError | Effect.Error<ReturnType<typeof deleteDisk>>,
    RuntimeContext
  >;
}

/**
 * Create disks at run time, one per user, session, or task, by name. This
 * is how most apps use Archil: a disk mounts in about 50 ms, so it can
 * belong to a single request. The client returns full disk handles (exec,
 * grep, objects, branches, disk tokens), the same shape the deploy-time
 * bindings return.
 *
 * Objects created at run time are tagged with the stack, stage and binding
 * (`alchemy::stack`, `alchemy::stage`, `alchemy::id`) and are not deleted
 * when the stack is destroyed. List them by those tags to clean them up.
 * Archil has no tags, labels or descriptions, so the tags are a name
 * prefix, `alc-<id>-<hash of stack/stage/id>`: every name this client
 * creates is `<prefix>-<name>`, and `prefix` on the client is the value.
 *
 * ### Disks per User
 * **Example:** A home disk for each user
 * ```typescript
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const disks = yield* Archil.CreateDisk();
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const request = yield* HttpServerRequest;
 *         const user = request.headers["x-user"] ?? "anonymous";
 *         const home = yield* disks.create(`user-${user}`);
 *         const result = yield* home.exec("ls -la /mnt/archil");
 *         return HttpServerResponse.text(result.stdout);
 *       }),
 *     };
 *   }).pipe(Effect.provide(Archil.CreateDiskHttp)),
 * ) {}
 * ```
 *
 * ### Cleaning Up
 * **Example:** Delete the disks one binding created
 * ```typescript
 * const disks = yield* Archil.CreateDisk();
 * for (const disk of yield* disks.list()) {
 *   yield* disks.delete(disk.name.slice(disks.prefix.length + 1));
 * }
 * ```
 *
 * @binding
 * @product Disk
 */
export interface CreateDisk extends Binding.Service<
  CreateDisk,
  "Archil.CreateDisk",
  (options?: CreateDiskOptions) => Effect.Effect<CreateDiskClient>
> {}

export const CreateDisk = Binding.Service<CreateDisk>("Archil.CreateDisk");

/** {@link CreateDisk} over Archil's HTTP API, usable from any host. */
export const CreateDiskHttp = Layer.effect(
  CreateDisk,
  Effect.gen(function* () {
    const access = yield* ApiAccess;
    return Effect.fn(function* (options?: CreateDiskOptions) {
      const authorize = yield* access();
      const { prefix: owner } = yield* runtimePrefix("Disks");
      const prefix = Effect.succeed(owner);
      const fullName = (name: string) => Effect.succeed(runtimeName(owner, name));
      const handle = (disk: { id: string; name: string }) =>
        makeDiskHandle({ diskId: disk.id, name: disk.name }, authorize);
      return {
        prefix: owner,
        create: (name, createOptions) =>
          authorize(
            Effect.gen(function* () {
              const disk = yield* ensureDisk(
                yield* fullName(name),
                createOptions?.storage ?? options?.storage,
              );
              return handle(disk);
            }),
          ),
        get: (name) =>
          authorize(
            Effect.gen(function* () {
              const diskName = yield* fullName(name);
              const disk = yield* findDiskByName(diskName);
              return disk && disk.status !== "deleted" ? handle(disk) : undefined;
            }),
          ),
        list: () =>
          authorize(
            Effect.gen(function* () {
              const p = yield* prefix;
              const disks = yield* Stream.runCollect(listAllDisks());
              return disks
                .filter((d) => d.name.startsWith(`${p}-`) && d.status !== "deleted")
                .map(handle);
            }),
          ),
        delete: (name) =>
          authorize(
            Effect.gen(function* () {
              const diskName = yield* fullName(name);
              const disk = yield* findDiskByName(diskName);
              if (disk) yield* deleteDisk(disk.id);
            }),
          ),
      } satisfies CreateDiskClient;
    });
  }),
);
