import * as sandboxes from "@distilled.cloud/vercel/sandboxes";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { VercelEnvironment } from "../VercelEnvironment.ts";
import type { Providers } from "../Providers.ts";

export interface SandboxSnapshotProps {
  /**
   * ID of the (running) sandbox session to snapshot (`sbx_…`). Changing the
   * session replaces the snapshot.
   */
  sessionId: string;
  /**
   * Number of milliseconds after which the snapshot expires and is deleted
   * by the platform. `0` disables expiration. Immutable — changing it
   * replaces the snapshot.
   */
  expiration?: number;
}

export type SandboxSnapshot = Resource<
  "Vercel.SandboxSnapshot",
  SandboxSnapshotProps,
  {
    /** The unique identifier of the snapshot (`snap_…`). */
    snapshotId: string;
    /** ID of the session the snapshot was created from. */
    sourceSessionId: string;
    /** The region where the snapshot is stored. */
    region: string | undefined;
    /** The status of the snapshot (`created` | `failed`). */
    status: string;
    /** The size of the snapshot in bytes. */
    sizeBytes: number;
    /** Timestamp (ms) when the snapshot expires, if it has an expiration. */
    expiresAt: number | undefined;
    /** Timestamp (ms) when the snapshot was created. */
    createdAt: number;
  },
  never,
  Providers
>;

type SandboxSnapshotAttributes = SandboxSnapshot["Attributes"];

/**
 * A snapshot of a Vercel Sandbox session's filesystem, usable to create new
 * sandboxes from a captured state.
 *
 * The source session must be **running** when the snapshot is taken.
 * Snapshots are immutable — every prop change replaces the snapshot — and a
 * snapshot deleted (or expired) out-of-band is simply re-created from the
 * session on the next deploy.
 *
 * @resource
 * @section Snapshotting a session
 * @example Snapshot a running sandbox session
 * ```typescript
 * const snapshot = yield* Vercel.SandboxSnapshot("Baseline", {
 *   sessionId: "sbx_abc123",
 * });
 * ```
 *
 * @example Snapshot without expiration
 * ```typescript
 * const snapshot = yield* Vercel.SandboxSnapshot("Golden", {
 *   sessionId: "sbx_abc123",
 *   expiration: 0,
 * });
 * ```
 *
 * @see https://vercel.com/docs/vercel-sandbox
 */
export const SandboxSnapshot = Resource<SandboxSnapshot>(
  "Vercel.SandboxSnapshot",
);

const toAttributes = (
  snapshot: sandboxes.Snapshot,
): SandboxSnapshotAttributes => ({
  snapshotId: snapshot.id,
  sourceSessionId: snapshot.sourceSessionId,
  region: snapshot.region,
  status: snapshot.status,
  sizeBytes: snapshot.sizeBytes,
  expiresAt: snapshot.expiresAt,
  createdAt: snapshot.createdAt,
});

/**
 * Observe a snapshot by id. A `deleted` snapshot is reported as missing —
 * the platform soft-deletes and keeps the row visible.
 */
const observeSnapshot = (snapshotId: string) =>
  Effect.gen(function* () {
    const { teamId } = yield* VercelEnvironment.current;
    const observed = yield* sandboxes
      .getSessionSnapshot({ snapshotId, teamId })
      .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
    if (observed === undefined || observed.snapshot.status === "deleted") {
      return undefined;
    }
    return observed.snapshot;
  });

export const SandboxSnapshotProvider = () =>
  Provider.succeed(SandboxSnapshot, {
    stables: [
      "snapshotId",
      "sourceSessionId",
      "region",
      "sizeBytes",
      "createdAt",
    ],
    diff: Effect.fn(function* ({ olds, news, output }) {
      if (!isResolved(news)) return undefined;
      if (!output) return undefined;
      // Snapshots are immutable captures — new session or expiration means
      // a new snapshot.
      if (
        news.sessionId !== olds.sessionId ||
        news.expiration !== olds.expiration
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),
    read: Effect.fn(function* ({ output }) {
      // Snapshot ids are opaque — without prior state there is nothing to
      // look up (and nothing to adopt).
      if (output === undefined) return undefined;
      const observed = yield* observeSnapshot(output.snapshotId);
      return observed === undefined ? undefined : toAttributes(observed);
    }),
    reconcile: Effect.fn(function* ({ news, output }) {
      const { teamId } = yield* VercelEnvironment.current;

      // Observe — `output` only caches the stable snapshot id; the
      // snapshot may have expired or been deleted out-of-band.
      if (output !== undefined) {
        const observed = yield* observeSnapshot(output.snapshotId);
        if (observed !== undefined) return toAttributes(observed);
      }

      // Ensure — take a fresh snapshot of the (running) session.
      const created = yield* sandboxes.createSessionSnapshot({
        sessionId: news.sessionId,
        ...(news.expiration !== undefined
          ? { expiration: news.expiration }
          : {}),
        teamId,
      });
      return toAttributes(created.snapshot);
    }),
    delete: Effect.fn(function* ({ output }) {
      const { teamId } = yield* VercelEnvironment.current;
      yield* sandboxes
        .deleteSessionSnapshot({ snapshotId: output.snapshotId, teamId })
        .pipe(
          Effect.catchTag("NotFound", () => Effect.void),
          // The API answers 400 ("Snapshot expired or deleted.") for a
          // soft-deleted snapshot — trust observation: only propagate when
          // the snapshot is genuinely still live.
          Effect.catchTag("BadRequest", (error) =>
            Effect.gen(function* () {
              const observed = yield* observeSnapshot(output.snapshotId);
              if (observed === undefined) return;
              return yield* Effect.fail(error);
            }),
          ),
        );
    }),
  });
