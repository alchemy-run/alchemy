import * as boat from "@distilled.cloud/boat-dev/boat";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { SnapshotFailed } from "./Errors.ts";
import { boatName, isGeneratedName } from "./internal/Ownership.ts";
import type { Providers } from "./Providers.ts";

export interface SnapshotProps {
  /**
   * The sandbox to save, e.g. a `Boat.Sandbox`'s `sandboxId`. Its disk is
   * frozen as it is at deploy. Changing it replaces the snapshot.
   */
  sandboxId: string;
  /**
   * Snapshot name: lowercase letters, digits and dashes, up to 63. If
   * omitted, a unique name is generated from the stack, stage and logical
   * ID. Changing it replaces the snapshot.
   */
  name?: string;
}

export interface SnapshotAttributes {
  /** The name sandboxes start from: `Boat.Sandbox({ from: name })`. */
  name: string;
  /** Boat's id for the frozen disk. */
  snapshotId: string | undefined;
  /** The sandbox it was saved from. */
  sourceSandboxId: string;
  /** The machine size it was saved from; sandboxes started from it default to it. */
  type: string | undefined;
  /** Restored size, in bytes. */
  sizeBytes: number | undefined;
}

export interface Snapshot extends Resource<
  "Boat.Snapshot",
  SnapshotProps,
  SnapshotAttributes,
  never,
  Providers
> {}

/**
 * A saved snapshot of a sandbox's disk. Sandboxes started from it begin
 * exactly where the source sandbox was when it was saved: installed
 * packages, cloned repositories, built caches.
 *
 * Build a sandbox once, save it, and start every later sandbox from the
 * snapshot instead of repeating the setup. Saving waits for the sandbox's
 * `setupScript` to finish.
 *
 * ### Saving a sandbox
 * **Example:** A golden image for agent sandboxes
 * ```typescript
 * export const Builder = Boat.Sandbox("Builder", {
 *   setupScript: "sudo apt-get install -y ripgrep && npm i -g pnpm",
 * });
 *
 * export const Golden = Effect.gen(function* () {
 *   const builder = yield* Builder;
 *   return yield* Boat.Snapshot("Golden", { sandboxId: builder.sandboxId });
 * });
 * ```
 *
 * ### Starting sandboxes from it
 * **Example:** A declared sandbox
 * ```typescript
 * const golden = yield* Golden;
 * const box = yield* Boat.Sandbox("Box", { from: golden.name });
 * ```
 *
 * **Example:** Sandboxes created at run time
 * ```typescript
 * const sandboxes = yield* Boat.CreateSandbox(Golden);
 * const sandbox = yield* sandboxes.create();
 * ```
 *
 * @resource
 * @product Snapshot
 */
export const Snapshot = Resource<Snapshot>("Boat.Snapshot");

/** Boat snapshot names: lowercase letters, digits and dashes. */
const snapshotName = (id: string, name: string | undefined) =>
  Effect.map(boatName(id, name, 63), (value) =>
    name !== undefined ? value : value.replace(/[^a-z0-9-]/g, "-"),
  );

const observeSnapshot = (name: string) =>
  boat.getSavedSnapshot({ name }).pipe(
    Effect.map((got): boat.SavedSnapshot | undefined => got.snapshot),
    Effect.catchTag("NotFound", () => Effect.undefined),
  );

const toAttributes = (snapshot: boat.SavedSnapshot): SnapshotAttributes => ({
  name: snapshot.name,
  snapshotId: snapshot.snapshotId,
  sourceSandboxId: snapshot.sourceSandboxId,
  type: snapshot.type,
  sizeBytes: snapshot.sizeBytes,
});

/** Saving takes seconds; poll until Boat reports `ready` or `failed` (about 90s at most). */
const awaitSaved = (name: string) =>
  boat.getSavedSnapshot({ name }).pipe(
    Effect.map((got) => got.snapshot),
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (snapshot) => snapshot.status !== "saving",
      times: 30,
    }),
    Effect.flatMap((snapshot) =>
      snapshot.status === "ready"
        ? Effect.succeed(snapshot)
        : new SnapshotFailed({
            snapshot: name,
            message:
              snapshot.status === "failed"
                ? `Boat could not save snapshot ${name}: ${snapshot.error ?? "unknown error"}`
                : `Boat snapshot ${name} was still saving after 90 seconds`,
          }),
    ),
  );

/**
 * A sandbox's setup script runs in the background after it starts. Wait
 * for it to finish (about three minutes at most), so the snapshot holds
 * what it set up.
 */
const awaitSetup = (sandboxId: string) =>
  boat.getSandbox({ sandboxId }).pipe(
    Effect.map((got) => got.sandbox?.setupStatus),
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (status) => status !== "pending" && status !== "running",
      times: 60,
    }),
    Effect.flatMap((status) =>
      status === "pending" || status === "running"
        ? new SnapshotFailed({
            snapshot: sandboxId,
            message: `Sandbox ${sandboxId}'s setup script was still running after three minutes`,
          })
        : Effect.void,
    ),
  );

export const SnapshotProvider = () =>
  Provider.effect(
    Snapshot,
    Effect.gen(function* () {
      return {
        stables: ["name"],
        diff: Effect.fn(function* ({ id, news, olds, output }) {
          if (!isResolved(news) || olds === undefined) return undefined;
          const name = yield* snapshotName(id, news.name ?? output?.name);
          if (news.sandboxId !== olds.sandboxId || (output !== undefined && name !== output.name)) {
            return { action: "replace" } as const;
          }
          return undefined;
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const name = output?.name ?? (yield* snapshotName(id, olds?.name));
          const snapshot = yield* observeSnapshot(name);
          if (snapshot === undefined) return undefined;
          const attrs = toAttributes(snapshot);
          const ours =
            output !== undefined ||
            snapshot.sourceSandboxId === olds?.sandboxId ||
            isGeneratedName(snapshot.name);
          return ours ? attrs : Unowned(attrs);
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = yield* snapshotName(id, news.name ?? output?.name);

          // Observe
          const observed = yield* observeSnapshot(name);
          if (observed?.status === "ready" && observed.sourceSandboxId === news.sandboxId) {
            return toAttributes(observed);
          }

          // Ensure — save (or finish a save already under way, or re-save one
          // Boat lost or one saved from another sandbox under this name).
          if (observed?.status !== "saving") {
            yield* awaitSetup(news.sandboxId);
            yield* session.note(`Saving sandbox ${news.sandboxId} as snapshot ${name}...`);
            yield* boat.saveSavedSnapshot({ sandboxId: news.sandboxId, name });
          }
          return toAttributes(yield* awaitSaved(name));
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* boat
            .deleteSavedSnapshot({ name: output.name })
            .pipe(Effect.catchTag("NotFound", () => Effect.void));
        }),
        list: Effect.fn(function* () {
          const listed = yield* boat.listSavedSnapshots({});
          return listed.snapshots
            .filter((snapshot) => isGeneratedName(snapshot.name))
            .map(toAttributes);
        }),
      };
    }),
  );
