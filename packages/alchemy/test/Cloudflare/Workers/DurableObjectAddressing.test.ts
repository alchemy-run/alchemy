import * as Cloudflare from "@/Cloudflare";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import AddressingStack from "./fixtures/do-addressing/stack.ts";

// Runs on the LOCAL runtime: this is a regression guard, so it has to be cheap
// enough to run on every change — ~12s here versus minutes for a deploy. The
// bug it covers is not deployment-specific (the namespace simply never wired
// the methods up), so `alchemy dev` reproduces it exactly. Note this still
// reaches Cloudflare for the state store, so it wants an account like the rest
// of the suite; the workers themselves stay local.
const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  state: Cloudflare.state(),
  dev: true,
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const HOOK_TIMEOUT = 120_000;
const TEST_TIMEOUT = 60_000;

const readinessSchedule = Schedule.min([
  Schedule.exponential("500 millis"),
  Schedule.spaced("3 seconds"),
]);

// GET a route and return its parsed JSON, retrying until the local runtime is
// serving. A non-200 carries the worker's error text, so a genuine failure
// surfaces as that message rather than a JSON parse error.
const json = <T>(url: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    return yield* client.get(url).pipe(
      Effect.flatMap((res) =>
        res.status === 200
          ? (res.json as Effect.Effect<unknown, unknown>)
          : Effect.flatMap(res.text, (body) =>
              Effect.fail(new Error(`${res.status}: ${body}`)),
            ),
      ),
      Effect.map((body) => body as T),
      Effect.timeout("15 seconds"),
      Effect.retry({ schedule: readinessSchedule, times: 20 }),
    );
  });

/**
 * Regression: the namespace declared `get`, `idFromName`, `idFromString` and
 * `newUniqueId` on its interface and implemented none of them — the object
 * literal wired up `getByName` and left the rest commented out directly below
 * it. TypeScript reported them as present while they were `undefined` at
 * runtime, so the interface lied and every call site found out in production.
 *
 * These assert the whole addressing surface reaches a real instance, and the
 * *right* one: each route bumps the target's own counter, which is the only
 * evidence that distinguishes "answered" from "answered from the instance you
 * asked for".
 */
describe("durable object addressing", () => {
  const stack = beforeAll(deploy(AddressingStack), { timeout: HOOK_TIMEOUT });
  afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(AddressingStack), {
    timeout: HOOK_TIMEOUT,
  });

  test(
    "get(idFromName(name)) reaches the same instance as getByName(name)",
    Effect.gen(function* () {
      const { url } = yield* stack;
      const name = `same-${crypto.randomUUID()}`;

      // A fresh name, so the first bump through either route must see 1.
      const first = yield* json<{ count: number }>(
        `${url}/by-name?name=${name}`,
      );
      expect(first.count).toBe(1);

      // The counter carries over only if this landed on that same instance —
      // an independent instance would answer 1 again.
      const second = yield* json<{ count: number }>(
        `${url}/by-id?name=${name}`,
      );
      expect(second.count).toBe(2);
    }).pipe(logLevel),
    { timeout: TEST_TIMEOUT },
  );

  test(
    "idFromString round-trips an id back to the same instance",
    Effect.gen(function* () {
      const { url } = yield* stack;
      const name = `roundtrip-${crypto.randomUUID()}`;

      const first = yield* json<{ count: number }>(
        `${url}/by-name?name=${name}`,
      );
      expect(first.count).toBe(1);

      // The id went out to its string form and back; it has to name the same
      // instance on the way home.
      const second = yield* json<{ count: number }>(
        `${url}/by-id-string?name=${name}`,
      );
      expect(second.count).toBe(2);
    }).pipe(logLevel),
    { timeout: TEST_TIMEOUT },
  );

  test(
    "newUniqueId yields a fresh instance every time",
    Effect.gen(function* () {
      const { url } = yield* stack;

      // Two unique ids, two brand-new instances — so neither has a counter yet
      // and both report 1. A shared or repeated id would show 1 then 2.
      const { first, second } = yield* json<{
        first: number;
        second: number;
      }>(`${url}/by-unique`);

      expect(first).toBe(1);
      expect(second).toBe(1);
    }).pipe(logLevel),
    { timeout: TEST_TIMEOUT },
  );
});
