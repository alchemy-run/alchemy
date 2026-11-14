import * as boat from "@distilled.cloud/boat-dev/boat";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { sha256Object } from "alchemy/Util/sha256";
import * as Effect from "effect/Effect";
import { SnapshotSetupFailed } from "./Errors.ts";
import { declarable } from "./internal/Declared.ts";
import { boatName, isGeneratedName, ownershipLabels } from "./internal/Ownership.ts";
import { awaitSaved, whileSaving } from "./internal/SavedSnapshot.ts";
import type { Providers } from "./Providers.ts";
import type { SandboxType } from "./Sandbox.ts";

/** A snapshot to start from: a `Boat.Snapshot`, declared or yielded, or `{ name }`. */
export interface SnapshotBase {
  name: string;
  /** A `Boat.Snapshot`'s setup hash. A rebuild replaces what starts from it. */
  setupHash?: string;
}

export interface SnapshotProps {
  /**
   * Shell commands run in order before the snapshot is saved: clone a
   * repository, install dependencies, warm a cache. A non-zero exit fails
   * the deploy with `SnapshotSetupFailed`.
   */
  run: string[];
  /**
   * The snapshot to start from: another `Boat.Snapshot`, or `{ name }` of
   * one saved elsewhere. Omit to start from a fresh sandbox. Rebuilding it
   * takes this snapshot again.
   */
  from?: SnapshotBase;
  /** Environment variables for the setup commands. */
  env?: Record<string, string>;
  /** Working directory for the setup commands. @default "/home/user" */
  cwd?: string;
  /**
   * Machine size to build on. Sandboxes started from the snapshot default
   * to it.
   * @default "default"
   */
  type?: SandboxType;
  /**
   * Snapshot name: lowercase letters, digits and dashes, up to 63. If
   * omitted, a unique name is generated from the stack, stage and logical
   * ID. Changing it replaces the snapshot.
   */
  name?: string;
}

export interface SnapshotAttributes {
  /** The name sandboxes start from. */
  name: string;
  /** Boat's id for the saved disk. */
  snapshotId: string | undefined;
  /** The machine size it was saved from. */
  type: string | undefined;
  /** Restored size, in bytes. */
  sizeBytes: number | undefined;
  /** Content hash of the base and setup. A deploy re-saves only when it changes. */
  setupHash: string;
}

export interface Snapshot extends Resource<
  "Boat.Snapshot",
  SnapshotProps,
  SnapshotAttributes,
  never,
  Providers,
  { name: string }
> {}

/**
 * A warm base for sandboxes: a sandbox set up with your commands and its
 * disk saved under a name. Sandboxes started from it begin exactly where
 * the setup left off: packages installed, a repository cloned, a build
 * cache warm.
 *
 * Use a snapshot for work that is too slow to repeat per sandbox. Alchemy
 * runs the commands in a sandbox of its own, saves it, and deletes the
 * sandbox. A deploy re-runs the setup only when the commands or the base
 * change, and a rebuild replaces the declared sandboxes started from it.
 *
 * ### Creating a Snapshot
 * **Example:** A repository with its dependencies installed
 * ```typescript
 * export const Golden = Boat.Snapshot("Golden", {
 *   run: [
 *     "git clone https://github.com/alchemy-run/alchemy ~/alchemy",
 *     "cd ~/alchemy && pnpm install",
 *   ],
 * });
 * ```
 *
 * **Example:** Layer one snapshot on another
 * ```typescript
 * export const Tools = Boat.Snapshot("Tools", { run: ["npm i -g pnpm"] });
 * export const Golden = Boat.Snapshot("Golden", { from: Tools, run: ["pnpm dlx playwright install"] });
 * ```
 *
 * ### Starting sandboxes from a Snapshot
 * **Example:** A declared sandbox
 * ```typescript
 * export const Box = Boat.Sandbox("Box", { snapshot: Golden });
 * ```
 *
 * **Example:** Sandboxes created at run time
 * ```typescript
 * const sandboxes = yield* Boat.CreateSandbox(Golden);
 * const sandbox = yield* sandboxes.create({ autoStop: "10 minutes" });
 * ```
 *
 * ### Referencing a snapshot the stack doesn't manage
 * **Example:** Look one up by name
 * ```typescript
 * const shared = Boat.Snapshot.lookup({ name: "team-base" });
 * const sandboxes = yield* Boat.CreateSandbox(shared);
 * ```
 *
 * @resource
 * @product Snapshot
 */
export const Snapshot = declarable<Snapshot>()(Resource<Snapshot>("Boat.Snapshot"));

/** Boat snapshot names: lowercase letters, digits and dashes. */
const snapshotName = (id: string, name: string | undefined) =>
  Effect.map(boatName(id, name, 63), (value) =>
    name !== undefined ? value : value.replace(/[^a-z0-9-]/g, "-"),
  );

const setupHashOf = (props: SnapshotProps) =>
  Effect.map(
    sha256Object({
      from: props.from === undefined ? null : [props.from.name, props.from.setupHash ?? null],
      run: props.run,
      env: props.env ?? {},
      cwd: props.cwd ?? null,
      type: props.type ?? "default",
    }),
    (hash) => hash.slice(0, 16),
  );

const observeSnapshot = (name: string) =>
  boat.getSavedSnapshot({ name }).pipe(
    Effect.map((got): boat.SavedSnapshot | undefined => got.snapshot),
    Effect.catchTag("NotFound", () => Effect.undefined),
  );

const toAttributes = (snapshot: boat.SavedSnapshot, setupHash: string): SnapshotAttributes => ({
  name: snapshot.name,
  snapshotId: snapshot.snapshotId,
  type: snapshot.type,
  sizeBytes: snapshot.sizeBytes,
  setupHash,
});

/** POSIX single quotes: the value verbatim. */
const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;

/**
 * Starts a setup sandbox (from `from`, with none of the account's secrets),
 * runs the commands, saves it as `name`, and always deletes the sandbox.
 */
const takeSnapshot = Effect.fn(function* (id: string, name: string, props: SnapshotProps) {
  const labels = yield* ownershipLabels(id);
  return yield* Effect.acquireUseRelease(
    boat.createSandbox({
      noEnv: true,
      ttlSeconds: 1800,
      ...(props.type === undefined ? {} : { type: props.type }),
      ...(props.from === undefined ? {} : { from: props.from.name }),
      labels,
    }),
    ({ sandbox }) =>
      Effect.gen(function* () {
        const exports = Object.entries(props.env ?? {})
          .map(([key, value]) => `export ${key}=${quote(value)}; `)
          .join("");
        for (const command of props.run) {
          const result = yield* boat.executeSandboxCommand({
            sandboxId: sandbox.id,
            command: `${exports}${command}`,
            timeoutSeconds: 600,
            ...(props.cwd === undefined ? {} : { cwd: props.cwd }),
          });
          const exitCode = "exitCode" in result ? (result.exitCode ?? -1) : -1;
          const timedOut = "timedOut" in result && result.timedOut === true;
          if (exitCode !== 0 || timedOut) {
            return yield* new SnapshotSetupFailed({
              message: timedOut
                ? `snapshot ${name}: \`${command}\` ran past 10 minutes`
                : `snapshot ${name}: \`${command}\` exited with ${exitCode}`,
              command,
              exitCode,
              stderr: "stderr" in result ? result.stderr.slice(-4000) : "",
            });
          }
        }
        // An earlier save under this name may still be running.
        yield* whileSaving(boat.saveSavedSnapshot({ sandboxId: sandbox.id, name }));
        return yield* awaitSaved(name);
      }),
    ({ sandbox }) =>
      Effect.ignore(boat.deleteSandbox({ sandboxId: sandbox.id, xAsciiConfirmDelete: sandbox.id })),
  );
});

export const SnapshotProvider = () =>
  Provider.effect(
    Snapshot,
    Effect.gen(function* () {
      return {
        stables: ["name"],
        diff: Effect.fn(function* ({ id, news, olds, output }) {
          if (!isResolved(news) || olds === undefined) return undefined;
          const name = yield* snapshotName(id, news.name ?? output?.name);
          if (output !== undefined && name !== output.name) return { action: "replace" } as const;
          if (output !== undefined && (yield* setupHashOf(news)) !== output.setupHash) {
            return { action: "update" } as const;
          }
          return undefined;
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const name = output?.name ?? (yield* snapshotName(id, olds?.name));
          const snapshot = yield* observeSnapshot(name);
          if (snapshot === undefined) return undefined;
          const attrs = toAttributes(snapshot, output?.setupHash ?? "");
          return output !== undefined || isGeneratedName(snapshot.name) ? attrs : Unowned(attrs);
        }),
        lookup: Effect.fn(function* ({ name }) {
          const snapshot = yield* observeSnapshot(name);
          return snapshot === undefined ? undefined : toAttributes(snapshot, "");
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = yield* snapshotName(id, news.name ?? output?.name);
          const setupHash = yield* setupHashOf(news);

          // Observe — a ready snapshot of this exact setup is kept.
          const observed = yield* observeSnapshot(name);
          if (observed?.status === "ready" && output?.setupHash === setupHash) {
            return toAttributes(observed, setupHash);
          }

          // Ensure — saving under an existing name replaces its disk.
          yield* session.note(`Building snapshot ${name}...`);
          return toAttributes(yield* takeSnapshot(id, name, news), setupHash);
        }),
        delete: Effect.fn(function* ({ output }) {
          // A save under this name (an interrupted deploy's) must settle first.
          yield* whileSaving(boat.deleteSavedSnapshot({ name: output.name })).pipe(
            Effect.catchTag("NotFound", () => Effect.void),
          );
        }),
        list: Effect.fn(function* () {
          const listed = yield* boat.listSavedSnapshots({});
          return listed.snapshots
            .filter((snapshot) => isGeneratedName(snapshot.name))
            .map((snapshot) => toAttributes(snapshot, ""));
        }),
      };
    }),
  );
