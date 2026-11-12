import { alarmCallbacks } from "@alchemy.run/rivet/AlarmCallback";
import { describe, expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";

const memoryStorage = () => {
  const rows = new Map<string, unknown>();
  return {
    get: <T>(key: string) => Effect.succeed(rows.get(key) as T | undefined),
    put: <T>(key: string, value: T) =>
      Effect.sync(() => {
        rows.set(key, value);
      }),
    delete: (key: string) =>
      Effect.sync(() => {
        const had = rows.has(key);
        rows.delete(key);
        return had;
      }),
    list: <T>(options?: { readonly prefix?: string }) =>
      Effect.sync(() => {
        const out = new Map<string, T>();
        for (const [key, value] of rows) {
          if (options?.prefix !== undefined && !key.startsWith(options.prefix)) continue;
          out.set(key, value as T);
        }
        return out;
      }),
    rows,
  };
};

describe("Rivet.alarmCallbacks", () => {
  it("schedules a job, fires it, and clears the row", async () => {
    const storage = memoryStorage();
    let alarm: number | null = null;
    const seen: Array<{ n: number }> = [];
    const callbacks = alarmCallbacks(storage, {
      set: (at) =>
        Effect.sync(() => {
          alarm = at;
        }),
      get: Effect.sync(() => alarm),
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        const job = yield* callbacks.makeCallback("tick", (payload: { n: number }) =>
          Effect.sync(() => {
            seen.push(payload);
          }),
        );
        yield* job.schedule("one", { after: 0, payload: { n: 7 } });
        expect(alarm).not.toBeNull();
        expect(storage.rows.size).toBe(1);
        yield* callbacks.fire;
        expect(seen).toEqual([{ n: 7 }]);
        expect(storage.rows.size).toBe(0);
      }),
    );
  });

  it("retries a failing job and keeps the row", async () => {
    const storage = memoryStorage();
    let alarm: number | null = null;
    let attempts = 0;
    const callbacks = alarmCallbacks(storage, {
      set: (at) =>
        Effect.sync(() => {
          alarm = at;
        }),
      get: Effect.sync(() => alarm),
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        const job = yield* callbacks.makeCallback(
          "fail",
          () =>
            Effect.sync(() => {
              attempts += 1;
            }).pipe(Effect.andThen(Effect.fail("boom"))),
          { retry: { delay: "1 second", maxAttempts: 3 } },
        );
        yield* job.schedule("x", { after: 0, payload: {} });
        yield* callbacks.fire;
        expect(attempts).toBe(1);
        expect(storage.rows.size).toBe(1);
        const status = yield* job.getStatus("x");
        expect(status?.attempts).toBe(1);
        expect(status?.parked).toBe(false);
      }),
    );
  });
});
