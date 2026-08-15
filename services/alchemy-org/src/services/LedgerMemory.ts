/**
 * The in-memory physics of {@link Ledger} — tests. Rows and metadata
 * live in process maps: nothing survives a restart, which is exactly
 * the point (each test starts from an empty book).
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Ledger } from "./Ledger.ts";

export const LedgerMemory: Layer.Layer<Ledger> = Layer.sync(Ledger, () => {
  const rows = new Map<string, "open" | "settled">();
  const meta = new Map<string, unknown>();
  const rowKey = (queue: string, key: string) => `${queue}\u0000${key}`;
  return Ledger.of({
    offer: (queue, key, _task) =>
      Effect.sync(() => {
        const id = rowKey(queue, key);
        if (rows.has(id)) return { status: "duplicate" as const };
        rows.set(id, "open");
        return { status: "accepted" as const };
      }),
    settle: (queue, key) =>
      Effect.sync(() => {
        const id = rowKey(queue, key);
        if (rows.has(id)) rows.set(id, "settled");
      }),
    put: (key, value) => Effect.sync(() => void meta.set(key, value)),
    get: (key) => Effect.sync(() => meta.get(key)),
  });
});
