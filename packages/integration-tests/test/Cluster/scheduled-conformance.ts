/** Singleton and cron cases, read through the journal they record to. */
import { expect } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Schedule from "effect/Schedule";

const journal = (url: string) =>
  HttpClient.get(url).pipe(
    Effect.flatMap((response) => response.json),
    Effect.map((body) => body as string[]),
  );

type TestFn = (name: string, effect: Effect.Effect<void, unknown, any>, options?: object) => void;

export const scheduledConformanceTests = (
  test: TestFn,
  {
    baseUrl,
    kind,
  }: {
    baseUrl: () => string;
    /** Whether the host under test runs in a real cloud or on this machine. */
    kind: "live" | "local";
  },
) => {
  const options = { timeout: 120_000, tags: [kind] };

  test(
    "a singleton runs on one runner at a time",
    Effect.gen(function* () {
      const url = `${baseUrl()}/wf/journal/heartbeat`;
      const atLeast = (count: number) =>
        journal(url).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("1 second"),
            until: (entries) => entries.length >= count,
            times: 60,
          }),
        );
      yield* atLeast(3);
      // Once shards have settled, every beat comes from the same runner. The
      // journal lives in memory, so read its newest beats rather than an
      // offset an instance restart would invalidate.
      yield* Effect.sleep("4 seconds");
      const recent = (yield* atLeast(3)).slice(-3);
      expect(recent.length).toBe(3);
      expect(new Set(recent).size).toBe(1);
    }),
    options,
  );

  test(
    "a cron runs each scheduled time once",
    Effect.gen(function* () {
      const entries = yield* journal(`${baseUrl()}/wf/journal/ticks`).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("1 second"),
          until: (entries) => entries.length >= 3,
          times: 90,
        }),
      );
      const times = entries.map(Number);
      expect(new Set(times).size).toBe(times.length);
      for (const time of times) expect(time % 2000).toBe(0);
    }),
    options,
  );
};
