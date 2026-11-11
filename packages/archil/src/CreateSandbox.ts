import * as archil from "@distilled.cloud/archil";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Random from "effect/Random";
import { ApiAccess, runtimeName, runtimePrefix } from "./ArchilBindings.ts";
import { makeSandboxHandle, type SandboxHandle } from "./Clients.ts";
import type { Image } from "./Image.ts";
import type { ArchilFailed, ArchilNotReady } from "./internal/archil.ts";
import { findSandboxByName, listSandboxes, waitForSandbox } from "./internal/archil.ts";
import {
  deleteSandbox,
  toCreateSandboxRequest,
  type Sandbox,
  type SandboxProps,
} from "./Sandbox.ts";
import {
  MountDiskUnresolved,
  mountDiskId,
  toSandboxMount,
  type DiskRef,
  type MountableDisk,
  type MountOptionUnsupported,
} from "./SandboxOptions.ts";

/**
 * A run-time create: a box {@link Sandbox}'s props (no program), with a
 * required name. A mount's disk is a `DiskHandle` (e.g. from
 * `CreateDisk`), or a `MountDisk` reference this host bound at deploy.
 */
export interface CreateSandboxRequest extends Omit<
  SandboxProps,
  "name" | "main" | "handler" | "port" | "build" | "extraFiles" | "isExternal"
> {
  /** Name, stamped with this binding's prefix. Lowercase letters, digits and `-`. */
  readonly name: string;
}

export type CreateSandboxError =
  | archil.CreateSandboxError
  | archil.ForkSandboxError
  | archil.GetSandboxError
  | archil.ListSandboxesError
  | ArchilFailed
  | ArchilNotReady
  | MountOptionUnsupported
  | MountDiskUnresolved;

/**
 * A mount's disk id at run time: a handle carries it; a declared disk
 * reads the id `MountDisk` bound into this host at deploy.
 */
const runtimeDiskId = Effect.fn(function* (disk: MountableDisk, path: string) {
  if (isDiskRef(disk)) return disk.diskId;
  if (Effect.isEffect(disk)) {
    return yield* new MountDiskUnresolved({
      path,
      message: `The disk mounted at ${path} is a declaration: bind it with Archil.MountDisk(disk) and pass that reference, or pass a DiskHandle.`,
    });
  }
  const diskId = yield* disk.diskId;
  return yield* diskId;
});

const isDiskRef = (disk: MountableDisk): disk is DiskRef => mountDiskId(disk) !== undefined;

export interface CreateSandboxClient {
  /**
   * The name prefix this client puts on everything it creates,
   * `alc-<id>-<hash of stack/stage/id>`.
   */
  readonly prefix: string;
  /**
   * Create a sandbox (or return the one that already has this name) and
   * wait until it is running. Takes a {@link Sandbox}'s props; the bound
   * image is the default.
   */
  create(
    request: CreateSandboxRequest,
  ): Effect.Effect<SandboxHandle, CreateSandboxError, RuntimeContext>;
  /** A sandbox this client created, or `undefined`. */
  get(
    name: string,
  ): Effect.Effect<SandboxHandle | undefined, archil.ListSandboxesError, RuntimeContext>;
  /** Every sandbox this client created. */
  list(): Effect.Effect<SandboxHandle[], archil.ListSandboxesError, RuntimeContext>;
  /** Delete a sandbox this client created. Deleting a missing sandbox succeeds. */
  delete(
    name: string,
  ): Effect.Effect<
    void,
    archil.ListSandboxesError | Effect.Error<ReturnType<typeof deleteSandbox>>,
    RuntimeContext
  >;
}

/**
 * Create sandboxes at run time, one per user, session, or task: Firecracker
 * microVMs with disks mounted, public ports, and an outbound network policy
 * that can inject credentials at the boundary. Bind an {@link Image} to make
 * it the default image; a run-time `create` takes the same props as a
 * deploy-time {@link Sandbox}. Bind a {@link Sandbox} instead and `create`
 * forks it: each sandbox starts from its memory and disk, with whatever its
 * `run` commands set up, and changes only its own copy.
 *
 * Objects created at run time are tagged with the stack, stage and binding
 * (`alchemy::stack`, `alchemy::stage`, `alchemy::id`) and are not deleted
 * when the stack is destroyed. List them by those tags to clean them up.
 * Archil has no tags, labels or descriptions, so the tags are a name
 * prefix, `alc-<id>-<hash of stack/stage/id>`: every sandbox (and fork)
 * this client creates is `<prefix>-<name>`, and `prefix` on the client is the value.
 *
 * ### Sandboxes per Task
 * **Example:** Run a task in a sandbox with the user's disk mounted
 * ```typescript
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const disks = yield* Archil.CreateDisk();
 *     const sandboxes = yield* Archil.CreateSandbox(Agent);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const home = yield* disks.create("user-1");
 *         const sandbox = yield* sandboxes.create({
 *           name: "task-1",
 *           mounts: [{ disk: home, path: "/home/user" }],
 *           network: { egress: { default: "deny", allow: ["registry.npmjs.org"] } },
 *           idleTtlSeconds: 300,
 *         });
 *         const result = yield* sandbox.exec("npm test", { cwd: "/home/user/app" });
 *         yield* sandbox.pause();
 *         return HttpServerResponse.text(result.stdout);
 *       }),
 *     };
 *   }).pipe(Effect.provide(Layer.mergeAll(Archil.CreateDiskHttp, Archil.CreateSandboxHttp))),
 * ) {}
 * ```
 *
 * ### Forking a Sandbox Built at Deploy
 * **Example:** A fork per user from a sandbox set up at deploy
 * ```typescript
 * export const Golden = Archil.Sandbox("Golden", {
 *   run: ["git clone --depth 1 https://github.com/sindresorhus/is ~/is"],
 * });
 *
 * // in a Worker or program:
 * const sandboxes = yield* Archil.CreateSandbox(Golden);
 * const sandbox = (yield* sandboxes.get(`user-${user}`)) ?? (yield* sandboxes.create({ name: `user-${user}` }));
 * const result = yield* sandbox.exec("git log -1", { cwd: "~/is" });
 * ```
 *
 * @binding
 * @product Sandbox
 */
export interface CreateSandbox extends Binding.Service<
  CreateSandbox,
  "Archil.CreateSandbox",
  (base?: Image | Sandbox) => Effect.Effect<CreateSandboxClient>
> {}

export const CreateSandbox = Binding.Service<CreateSandbox>("Archil.CreateSandbox");

/** {@link CreateSandbox} over Archil's HTTP API, usable from any host. */
export const CreateSandboxHttp = Layer.effect(
  CreateSandbox,
  Effect.gen(function* () {
    const access = yield* ApiAccess;
    return Effect.fn(function* (base?: Image | Sandbox) {
      const authorize = yield* access();
      const { prefix: owner } = yield* runtimePrefix("Sandboxes");
      const prefix = Effect.succeed(owner);
      // Resources are proxies (every property reads as an Output), so tell a
      // bound sandbox from a bound image by its type, not by `in`.
      const isSandbox = (b: Image | Sandbox): b is Sandbox => b.Type === "Archil.Sandbox";
      const source = base !== undefined && isSandbox(base) ? yield* base.sandboxId : undefined;
      const imageId = base !== undefined && !isSandbox(base) ? yield* base.imageId : undefined;
      const fullName = (name: string) => Effect.succeed(runtimeName(owner, name));
      // Forks carry the same prefix as the sandboxes they come from; an
      // unnamed fork gets a random name.
      const forkName = Effect.fn(function* (name: string | undefined) {
        const id = (yield* Random.nextIntBetween(0, 2 ** 31)).toString(36);
        return yield* fullName(name ?? `fork-${id}`);
      });
      const handle = (s: { sandbox_id: string; name: string }) =>
        makeSandboxHandle({ sandboxId: s.sandbox_id, name: s.name }, authorize, forkName);
      return {
        prefix: owner,
        create: (request) =>
          authorize(
            Effect.gen(function* () {
              const name = yield* fullName(request.name);
              const existing = yield* findSandboxByName(name);
              if (existing) return handle(existing);
              if (source !== undefined) {
                // A bound sandbox is the base: fork its memory and disk.
                const { data } = yield* archil.forkSandbox({
                  sid: yield* source,
                  wait: true,
                  name,
                });
                return handle(yield* waitForSandbox(data.sandbox_id));
              }
              const defaultImage =
                request.image === undefined && request.baseImage === undefined && imageId
                  ? yield* imageId
                  : request.image;
              const mounts: archil.SandboxMount[] = [];
              for (const mount of request.mounts ?? []) {
                const diskId = yield* runtimeDiskId(mount.disk, mount.path);
                mounts.push(yield* toSandboxMount(diskId, mount));
              }
              const { data } = yield* archil
                .createSandbox(
                  toCreateSandboxRequest(name, { ...request, image: defaultImage }, mounts),
                )
                .pipe(
                  Effect.catchTag("SandboxNameConflict", (conflict) =>
                    findSandboxByName(name).pipe(
                      Effect.flatMap((found) =>
                        found ? Effect.succeed({ data: found }) : Effect.fail(conflict),
                      ),
                    ),
                  ),
                );
              return handle(yield* waitForSandbox(data.sandbox_id));
            }),
          ),
        get: (name) =>
          authorize(
            Effect.gen(function* () {
              const sandboxName = yield* fullName(name);
              const found = yield* findSandboxByName(sandboxName);
              return found ? handle(found) : undefined;
            }),
          ),
        list: () =>
          authorize(
            Effect.gen(function* () {
              const p = yield* prefix;
              return (yield* listSandboxes())
                .filter((s) => s.name.startsWith(`${p}-`) && s.status !== "deleted")
                .map(handle);
            }),
          ),
        delete: (name) =>
          authorize(
            Effect.gen(function* () {
              const sandboxName = yield* fullName(name);
              const found = yield* findSandboxByName(sandboxName);
              if (found) yield* deleteSandbox(found.sandbox_id);
            }),
          ),
      } satisfies CreateSandboxClient;
    });
  }),
);
