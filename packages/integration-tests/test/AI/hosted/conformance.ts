/**
 * The cases every platform that hosts a process must pass, driven over HTTP
 * against a deployed front that serves `desk.ts`'s routes.
 */
import { expect } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Schedule from "effect/Schedule";

type TestFn = (
  name: string,
  effect: Effect.Effect<void, any, any>,
  options?: { readonly timeout?: number; readonly tags?: ReadonlyArray<string> },
) => void;

export interface HostedOptions {
  readonly test: TestFn;
  /** The front's base URL, once it is deployed. */
  readonly url: Effect.Effect<string, any, any>;
  /** How long one case may take. */
  readonly timeout?: number;
}

const fresh = (name: string) => `${name}-${crypto.randomUUID().slice(0, 8)}`;

const get = <T>(base: string, path: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.get(`${base}${path}`);
    if (response.status !== 200) {
      return yield* Effect.fail(
        new Error(`${path} answered ${response.status}: ${yield* response.text}`),
      );
    }
    return (yield* response.json) as T;
  });

/** Wait for the front to serve. */
export const waitForReady = (url: string) =>
  get<unknown>(url, "/ready").pipe(
    Effect.catch(() => Effect.fail("not ready")),
    Effect.retry({ schedule: Schedule.spaced("3 seconds"), times: 60 }),
    Effect.ignore,
  );

interface Session {
  readonly status: "idle" | "working";
  readonly queued: ReadonlyArray<unknown>;
  readonly items: ReadonlyArray<{
    readonly seq: number;
    readonly item: { readonly type: string; readonly text?: string };
  }>;
}

export const hosted = ({ test, url, timeout = 120_000 }: HostedOptions) => {
  test(
    "a caller asks a session, which runs in an instance of its own and answers",
    Effect.gen(function* () {
      const base = yield* url;
      const key = fresh("ask");
      const asked = yield* get<{ answer: string }>(base, `/ask/${key}?text=hello`);
      expect(asked.answer).toBe(`Closed ${key}.`);
      // The session's command went from its instance to the model's.
      expect(yield* get(base, `/ticket/${key}`)).toEqual({ open: false, closedBy: "helper:hello" });
    }),
    { timeout, tags: ["local"] },
  );

  test(
    "a model's policy hands a session work, and the session reports with a command",
    Effect.gen(function* () {
      const base = yield* url;
      const key = fresh("open");
      yield* get(base, `/open/${key}?subject=printer`);
      const ticket = yield* get<{ open: boolean; closedBy: string | null }>(
        base,
        `/ticket/${key}`,
      ).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("500 millis"),
          until: (ticket) => ticket.closedBy !== null,
          times: 60,
        }),
      );
      expect(ticket).toEqual({ open: false, closedBy: "helper:printer" });
    }),
    { timeout, tags: ["local"] },
  );

  test(
    "where a session stands and its transcript are read from outside it, each key its own",
    Effect.gen(function* () {
      const base = yield* url;
      const key = fresh("read");
      // A session nobody sent anything is idle, with nothing stored.
      expect(yield* get<Session>(base, `/session/${key}`)).toEqual({
        status: "idle",
        queued: [],
        items: [],
      });
      yield* get(base, `/ask/${key}?text=one`);
      yield* get(base, `/ask/${key}?text=two`);
      const session = yield* get<Session>(base, `/session/${key}`);
      expect(session.status).toBe("idle");
      expect(session.items.map(({ item }) => item.text)).toEqual([
        "one",
        `Closed ${key}.`,
        "two",
        `Closed ${key}.`,
      ]);
      // Another key's session has none of it.
      expect((yield* get<Session>(base, `/session/${fresh("other")}`)).items).toEqual([]);
    }),
    { timeout, tags: ["local"] },
  );
};
