import * as boat from "@distilled.cloud/boat-dev/boat";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { SnapshotFailed } from "../Errors.ts";

/**
 * How long to wait for a save. A save runs in the background, and a running
 * sandbox takes a fresh capture first, which can take minutes.
 */
const SAVE_TIMEOUT = "10 minutes";
const poll = { schedule: Schedule.spaced("5 seconds"), times: 120 } as const;

/** Polls until Boat reports the snapshot `ready` (succeeds) or `failed` (fails). */
export const awaitSaved = (name: string) =>
  boat.getSavedSnapshot({ name }).pipe(
    Effect.map((got) => got.snapshot),
    Effect.repeat({ ...poll, until: (snapshot) => snapshot.status !== "saving" }),
    Effect.flatMap((snapshot) =>
      snapshot.status === "ready"
        ? Effect.succeed(snapshot)
        : new SnapshotFailed({
            snapshot: name,
            message:
              snapshot.status === "failed"
                ? `Boat could not save snapshot ${name}: ${snapshot.error ?? "unknown error"}`
                : `Boat snapshot ${name} was still saving after ${SAVE_TIMEOUT}`,
          }),
    ),
  );

/** Retries a saved-snapshot write while an earlier save under the same name is running. */
export const whileSaving = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
) => effect.pipe(Effect.retry({ ...poll, while: (error) => error._tag === "SaveInProgress" }));
