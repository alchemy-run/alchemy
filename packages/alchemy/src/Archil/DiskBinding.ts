import * as Effect from "effect/Effect";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import * as Binding from "../Binding.ts";
import { execDisk, grepDisk, type GrepRequest } from "./Api.ts";
import { ApiToken } from "./ApiToken.ts";
import { Credentials } from "./Credentials.ts";
import type { Disk } from "./Disk.ts";
import type { ExecClient } from "./Exec.ts";
import type { GrepClient } from "./Grep.ts";
import type { DiskConnection } from "./Connect.ts";
import type { ForkClient } from "./Fork.ts";
import {
  authorizeWith,
  forkBranch,
  makeConnection,
  type ArchilAuth,
} from "./RuntimeAuth.ts";
import type { ArchilRegion } from "./Region.ts";

/**
 * Shared scaffolding for the disk-scoped Archil capabilities ({@link Exec},
 * {@link Grep}).
 *
 * Each capability ships two interchangeable layers built from the builders
 * below: a `*Http` variant that mints a per-host `Archil.ApiToken`, and a
 * `*Local` variant that runs on the ambient deploy-time credentials. Both
 * resolve the bound disk's ID and region through the resource's own
 * accessors, so the capability follows the disk across regions.
 *
 * NOT exported from `index.ts`.
 */

/** Build the impl Effect for a token-scoped (`*Http`) disk capability. */
export const makeHttpDiskBinding = <C>(
  tag: string,
  makeClient: (
    auth: ArchilAuth,
    diskId: Effect.Effect<string>,
    region: Effect.Effect<ArchilRegion>,
  ) => C,
) =>
  Effect.gen(function* () {
    const Token = yield* ApiToken;
    return Effect.fn(tag)(function* (disk: Disk) {
      // `Binding.Host` (requirement-free, unlike `Self`) resolves the host on
      // every platform. All capabilities share one token id per host, so a
      // host binding several of them mints one token, not one each.
      const host = yield* Binding.Host;
      const token = yield* Token(`${host.LogicalId}ArchilToken`);
      const value = yield* token.value;
      return makeClient(
        authorizeWith(value),
        yield* disk.diskId,
        yield* disk.region,
      );
    });
  });

/** Build the impl Effect for an ambient-credentials (`*Local`) capability. */
export const makeLocalDiskBinding = <C>(
  tag: string,
  makeClient: (
    auth: ArchilAuth,
    diskId: Effect.Effect<string>,
    region: Effect.Effect<ArchilRegion>,
  ) => C,
) =>
  Effect.gen(function* () {
    // Credentials + HTTP client are ambient during stack-eval; capture the
    // context so each op runs with the current credentials. Registers no
    // binding on any host.
    const context = yield* Effect.context<
      Credentials | HttpClient.HttpClient
    >();
    const auth: ArchilAuth = {
      authorize: (eff) => eff.pipe(Effect.provideContext(context)),
    };
    return Effect.fn(tag)(function* (disk: Disk) {
      return makeClient(auth, yield* disk.diskId, yield* disk.region);
    });
  });

export const makeConnectionClient = (
  auth: ArchilAuth,
  diskId: Effect.Effect<string>,
  region: Effect.Effect<ArchilRegion>,
): DiskConnection => makeConnection(auth, diskId, region);

export const makeForkClient = (
  auth: ArchilAuth,
  diskId: Effect.Effect<string>,
  region: Effect.Effect<ArchilRegion>,
): ForkClient =>
  Effect.fn("Archil.Fork")(function* (
    name: string,
    options?: { from?: string; fromBranch?: string },
  ) {
    const branch = yield* forkBranch(auth, diskId, region, name, options);
    // A branch carries its own filesystem id, so it is addressed like any
    // other disk.
    return makeConnection(auth, Effect.succeed(branch.filesystemId), region);
  });

export const makeExecClient = (
  auth: ArchilAuth,
  diskId: Effect.Effect<string>,
  region: Effect.Effect<ArchilRegion>,
): ExecClient =>
  Effect.fn("Archil.Exec")(function* (command: string) {
    return yield* auth.authorize(
      execDisk({ region: yield* region, diskId: yield* diskId, command }),
    );
  });

export const makeGrepClient = (
  auth: ArchilAuth,
  diskId: Effect.Effect<string>,
  region: Effect.Effect<ArchilRegion>,
): GrepClient =>
  Effect.fn("Archil.Grep")(function* (request: GrepRequest) {
    return yield* auth.authorize(
      grepDisk({ region: yield* region, diskId: yield* diskId, ...request }),
    );
  });
