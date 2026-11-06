import * as Cloudflare from "@alchemy.run/cloudflare";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Schedule from "effect/Schedule";
import { call, seedAccounts, serving } from "./bench.ts";
import MoveV0 from "./fixtures/move/v0.ts";
import MoveV1Broken from "./fixtures/move/v1-broken.ts";
import MoveV1Timeout from "./fixtures/move/v1-timeout.ts";
import MoveV1 from "./fixtures/move/v1.ts";
import MoveV1b from "./fixtures/move/v1b.ts";
import {
  backdatePasses,
  boundClasses,
  depositsOf,
  namespacesOf,
  untilListed,
  writer,
} from "./move.ts";

/**
 * Moving a Domain from version 0 to the one class of version 1 when the
 * upgrade deploy doesn't finish: it is killed partway, it gives up waiting,
 * or it ships a bug. The next deploy finishes the move; nothing is lost or
 * applied twice, and the old classes stay until the move has settled.
 */

const { test } = Test.make({ providers: Cloudflare.providers() });

const ACCOUNTS = 60;
const DEPOSITS = 5;
/** The classes whose objects Cloudflare must list before the upgrade can see them. */
const LISTED = ["Ledger.AccountAggregate", "Ledger.DepositsView"];

const sum = (from: number, to: number) => ((from + to) * (to - from + 1)) / 2;
const json = <A>(url: string, path: string) =>
  call(url, "GET", path).pipe(Effect.map((body) => JSON.parse(body) as A));

/** Deploy version 0, seed its accounts, and wait until Cloudflare lists their objects. */
const atVersion0 = (stack: Test.ScratchStack) =>
  Effect.gen(function* () {
    yield* stack.destroy();
    const { worker } = yield* stack.deploy(
      Effect.gen(function* () {
        return { worker: yield* MoveV0 };
      }),
    );
    const url = worker.url!.replace(/\/+$/, "");
    const scriptName = worker.workerName;
    yield* serving(url, "v0");
    yield* seedAccounts(url, ACCOUNTS, DEPOSITS);
    const namespaces = yield* namespacesOf(scriptName);
    yield* untilListed(
      LISTED.map((name) => namespaces[name]!),
      (count) => count >= ACCOUNTS,
    );
    // Every class of version 0: each moves to the shared class.
    const legacy = Object.keys(yield* boundClasses(scriptName));
    return { url, scriptName, legacy };
  });

/** Every account reads its deposits, in the aggregate and in its view. */
const everyAccountReads = (url: string, balances: Record<string, number> = {}) =>
  Effect.forEach(
    Array.from({ length: ACCOUNTS }, (_, i) => `b${i}`),
    (key) =>
      Effect.gen(function* () {
        expect(yield* json(url, `/account/${key}`)).toEqual({
          balance: balances[key] ?? sum(1, DEPOSITS),
        });
      }),
    { concurrency: 10, discard: true },
  );

/** Every account's new object owns its data, and its view has every deposit once. */
const everyAccountMoved = (url: string) =>
  Effect.forEach(
    Array.from({ length: ACCOUNTS }, (_, i) => `b${i}`),
    (key) =>
      Effect.gen(function* () {
        const state = yield* json<{ phase: string } | null>(url, `/move/${key}`).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("2 seconds"),
            until: (state) => state?.phase === "owned",
            times: 30,
          }),
        );
        expect({ key, phase: state?.phase }).toEqual({ key, phase: "owned" });
        const view = yield* depositsOf(url, key);
        expect({ key, repeated: view.repeated }).toEqual({ key, repeated: 0 });
      }),
    { concurrency: 10, discard: true },
  );

/** Once the move has settled, the next upload deletes the old classes; the data stays. */
const oldClassesDeleted = (
  stack: Test.ScratchStack,
  url: string,
  scriptName: string,
  legacy: ReadonlyArray<string>,
  balances: Record<string, number> = {},
) =>
  Effect.gen(function* () {
    // Until then the old classes stay.
    expect(Object.keys(yield* boundClasses(scriptName))).toEqual(
      expect.arrayContaining([...legacy]),
    );
    yield* backdatePasses(scriptName, legacy);
    yield* stack.deploy(
      Effect.gen(function* () {
        return { worker: yield* MoveV1b };
      }),
    );
    yield* serving(url, "v1b");
    expect(Object.keys(yield* boundClasses(scriptName))).toEqual(["Ledger.Domain"]);
    yield* everyAccountReads(url, balances);
  });

const deployV1 = (stack: Test.ScratchStack) =>
  stack.deploy(
    Effect.gen(function* () {
      return { worker: yield* MoveV1 };
    }),
  );

describe("resuming a Domain's move to one class", { tags: ["provider:cloudflare", "live"] }, () => {
  test.provider(
    "an upgrade deploy killed partway is finished by the next one, while an account is written",
    (stack) =>
      Effect.gen(function* () {
        const { url, scriptName, legacy } = yield* atVersion0(stack);
        const log = { written: [] as Array<number>, failures: [] as Array<string>, stop: false };
        const writing = yield* Effect.forkChild(writer(url, "b0", 1_000, log));

        // Kill the deploy as soon as the new code serves: the move has at most begun.
        const deploying = yield* Effect.forkChild(deployV1(stack));
        yield* serving(url, "v1");
        yield* Fiber.interrupt(deploying);
        // Every key still answers, from its old object or its new one. (b0 is being written.)
        for (let i = 1; i < ACCOUNTS; i++)
          expect(yield* json(url, `/account/b${i}`)).toEqual({ balance: sum(1, DEPOSITS) });

        // Run the deploy again: it finishes the move.
        yield* deployV1(stack);
        log.stop = true;
        yield* Fiber.join(writing);
        expect(log.failures).toEqual([]);
        expect(log.written.length).toBeGreaterThan(5);
        const balances = { b0: sum(1, DEPOSITS) + log.written.reduce((a, b) => a + b, 0) };
        yield* everyAccountMoved(url);
        yield* everyAccountReads(url, balances);
        // Each deposit the writer made reached the view once.
        const view = yield* depositsOf(url, "b0", log.written).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("3 seconds"),
            until: (view) => view.missing.length === 0,
            times: 30,
          }),
        );
        expect(view.missing).toEqual([]);
        expect(view.count).toBe(DEPOSITS + log.written.length);

        yield* oldClassesDeleted(stack, url, scriptName, legacy, balances);
        yield* stack.destroy();
      }),
    { timeout: 1_800_000 },
  );

  test.provider(
    "an upgrade deploy that stops waiting for the move fails, and the next one finishes it",
    (stack) =>
      Effect.gen(function* () {
        const { url, scriptName, legacy } = yield* atVersion0(stack);

        const gaveUp = yield* stack
          .deploy(
            Effect.gen(function* () {
              return { worker: yield* MoveV1Timeout };
            }),
          )
          .pipe(Effect.exit);
        expect(Exit.isFailure(gaveUp)).toBe(true);
        if (Exit.isFailure(gaveUp)) expect(Cause.pretty(gaveUp.cause)).toContain("still running");
        yield* serving(url, "v1");
        yield* everyAccountReads(url);

        yield* deployV1(stack);
        yield* everyAccountMoved(url);
        yield* everyAccountReads(url);
        yield* oldClassesDeleted(stack, url, scriptName, legacy);
        yield* stack.destroy();
      }),
    { timeout: 1_800_000 },
  );

  test.provider(
    "an upgrade deploy with a bug fails, and the fixed code finishes the move",
    (stack) =>
      Effect.gen(function* () {
        const { url, scriptName, legacy } = yield* atVersion0(stack);

        const broken = yield* stack
          .deploy(
            Effect.gen(function* () {
              return { worker: yield* MoveV1Broken };
            }),
          )
          .pipe(Effect.exit);
        if (Exit.isFailure(broken))
          console.log(`MOVE-BROKEN ${Cause.pretty(broken.cause).slice(0, 2000)}`);
        expect(Exit.isFailure(broken)).toBe(true);

        // The fix.
        yield* deployV1(stack);
        yield* serving(url, "v1");
        yield* everyAccountMoved(url);
        yield* everyAccountReads(url);
        // And it takes new writes.
        yield* call(url, "POST", `/deposit/b1/${1_000}/1`);
        expect(yield* json(url, "/account/b1")).toEqual({ balance: sum(1, DEPOSITS) + 1_000 });
        yield* oldClassesDeleted(stack, url, scriptName, legacy, { b1: sum(1, DEPOSITS) + 1_000 });
        yield* stack.destroy();
      }),
    { timeout: 1_800_000 },
  );
});
