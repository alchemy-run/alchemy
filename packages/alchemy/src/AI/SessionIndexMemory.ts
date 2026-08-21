import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  SessionIndex,
  sessionId,
  type SessionSummary,
} from "./SessionIndex.ts";

export interface SessionIndexMemoryOptions {
  /** Bytes of the first input retained on the summary. @default 4000 */
  readonly firstInputBytes?: number;
}

interface IndexRow {
  readonly term: string;
  readonly key: string;
  status: SessionSummary["status"];
  ticks: number;
  readonly createdAt: number;
  updatedAt: number;
  parent: string | undefined;
  firstInput: string | undefined;
}

/** The in-memory {@link SessionIndex}: a single process's directory,
 *  exactly as durable as the process. */
export const SessionIndexMemory = (
  options?: SessionIndexMemoryOptions,
): Layer.Layer<SessionIndex> =>
  Layer.sync(SessionIndex, () => {
    const firstInputBytes = options?.firstInputBytes ?? 4000;
    const rows = new Map<string, IndexRow>();

    const ensure = (term: string, key: string): IndexRow => {
      const id = sessionId(term, key);
      let row = rows.get(id);
      if (row === undefined) {
        row = {
          term,
          key,
          status: "running",
          ticks: 0,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          parent: undefined,
          firstInput: undefined,
        };
        rows.set(id, row);
      }
      return row;
    };

    return {
      ingest: (observation) =>
        Effect.sync(() => {
          const row = ensure(observation.term, observation.key);
          row.updatedAt = observation.at;
          switch (observation.type) {
            case "admitted":
              if (observation.parent !== undefined) {
                row.parent = sessionId(
                  observation.parent.term,
                  observation.parent.key,
                );
              }
              return;
            case "input":
              row.firstInput ??= observation.text.slice(0, firstInputBytes);
              row.status = "running";
              return;
            case "assistant":
              row.ticks++;
              return;
            // the working/waiting line: parked = idle until the next
            // input wakes it (settled/crashed sessions emit nothing
            // after)
            case "parked":
              row.status = "idle";
              return;
            case "settled":
              row.status = "settled";
              return;
            case "crashed":
              row.status = "crashed";
              return;
            default:
              return;
          }
        }),
      remove: (id) =>
        Effect.sync(() => {
          rows.delete(id);
        }),
      list: () =>
        Effect.sync(() =>
          [...rows.entries()]
            .map(([id, row]) => ({
              id,
              term: row.term,
              key: row.key,
              status: row.status,
              ticks: row.ticks,
              createdAt: row.createdAt,
              updatedAt: row.updatedAt,
              parent: row.parent,
              firstInput: row.firstInput,
            }))
            .sort((a, b) => b.updatedAt - a.updatedAt),
        ),
    };
  });
