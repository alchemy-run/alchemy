import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Redacted from "effect/Redacted";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import * as Binding from "../Binding.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import {
  exec,
  execDisk,
  grepDisk,
  type ExecMountSpec,
  type GrepRequest,
} from "./Api.ts";
import { ApiToken } from "./ApiToken.ts";
import { Credentials } from "./Credentials.ts";
import { isDisk, type Disk } from "./Disk.ts";
import type { MultiExecMount, MultiExecMounts } from "./MultiExec.ts";
import { DEFAULT_REGION, type ArchilRegion } from "./Region.ts";

/**
 * Shared scaffolding for the Archil capability binding layers.
 *
 * The `*Http` layers mint a dedicated {@link ApiToken} per host and read it
 * back through the bound accessor at runtime; the `*Local` layers capture the
 * ambient deploy-time credentials. Both produce an {@link ArchilAuth} so every
 * capability shares the exact same runtime client implementations below.
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
 * Auth for the `*Http` layers: mint one `Archil.ApiToken` per host
 * Function/Worker and bind its value as a secret. The accessor machinery
 * delivers the token to the host environment on every cloud (secret binding
 * on Workers, env var on Lambda/ECS/EKS), so the same layer works anywhere.
 */
export const makeHttpAuth = Effect.gen(function* () {
  const Token = yield* ApiToken;
  return Effect.gen(function* () {
    // Binding.Host (requirement-free, unlike `Self`) resolves the host
    // Function/Worker on every platform — Lambda's `FunctionServices` does
    // not admit a `Self` requirement.
    const host = yield* Binding.Host;
    const token = yield* Token(`${host.LogicalId}ArchilToken`);
    const value = yield* token.value;
    return authorizeWith(value);
  });
});

/**
 * Auth for the `*Local` layers: capture the ambient current-credentials
 * context (the stack's providers layer) so ops run with the CLI/profile
 * API key. Registers no binding on any host.
 */
export const makeLocalAuth = Effect.gen(function* () {
  const context = yield* Effect.context<Credentials | HttpClient.HttpClient>();
  const auth: ArchilAuth = {
    authorize: (eff) => eff.pipe(Effect.provideContext(context)),
  };
  return Effect.succeed(auth);
});

// ============================================================================
// Runtime clients (shared by Http + Local layers)
// ============================================================================

export const makeExecClient = (
  auth: ArchilAuth,
  diskId: Effect.Effect<string>,
  region: Effect.Effect<ArchilRegion>,
) =>
  Effect.fn("Archil.Exec")(function* (command: string) {
    return yield* auth.authorize(
      execDisk({
        region: yield* region,
        diskId: yield* diskId,
        command,
      }),
    );
  });

export const makeGrepClient = (
  auth: ArchilAuth,
  diskId: Effect.Effect<string>,
  region: Effect.Effect<ArchilRegion>,
) =>
  Effect.fn("Archil.Grep")(function* (request: GrepRequest) {
    return yield* auth.authorize(
      grepDisk({
        region: yield* region,
        diskId: yield* diskId,
        ...request,
      }),
    );
  });

export interface ResolvedMount {
  path: string;
  diskId: Effect.Effect<string>;
  subdirectory: string | undefined;
  readOnly: boolean | undefined;
}

const diskOf = (mount: MultiExecMount): Disk =>
  isDisk(mount) ? mount : mount.disk;

/**
 * Resolve a {@link MultiExecMounts} map into deferred per-mount accessors
 * plus the shared region (taken from the first disk — Archil requires all
 * disks of one exec to live in the same region).
 */
export const resolveMounts = Effect.fn(function* (disks: MultiExecMounts) {
  const mounts: ResolvedMount[] = [];
  let region: Effect.Effect<ArchilRegion> | undefined;
  for (const [path, mount] of Object.entries(disks)) {
    const disk = diskOf(mount);
    if (region === undefined) {
      region = yield* disk.region;
    }
    mounts.push({
      path,
      diskId: yield* disk.diskId,
      subdirectory: isDisk(mount) ? undefined : mount.subdirectory,
      readOnly: isDisk(mount) ? undefined : mount.readOnly,
    });
  }
  if (region === undefined) {
    return yield* Effect.die(
      "Archil.MultiExec requires at least one disk to mount.",
    );
  }
  return { mounts, region };
});

export const makeMultiExecClient = (
  auth: ArchilAuth,
  region: Effect.Effect<ArchilRegion>,
  mounts: ResolvedMount[],
) =>
  Effect.fn("Archil.MultiExec")(function* (command: string) {
    const disks: Record<string, string | ExecMountSpec> = {};
    for (const mount of mounts) {
      const id = yield* mount.diskId;
      disks[mount.path] =
        mount.subdirectory !== undefined || mount.readOnly !== undefined
          ? {
              disk: id,
              subdirectory: mount.subdirectory,
              readOnly: mount.readOnly,
            }
          : id;
    }
    return yield* auth.authorize(
      exec({ region: yield* region, disks, command }),
    );
  });
