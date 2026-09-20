import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import {
  assertAppGone,
  assertCommitted,
  census,
  deployWorker,
} from "./fixtures/bluegreen.ts";
import { throughProxy, transportProxy } from "./fixtures/transport.ts";

let endpoint: string | undefined;
const { test } = Test.make({ providers: throughProxy(() => endpoint) });

test.provider(
  "F03 F08 partial promotion loses the first uncordon response without rolling back serving green",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const initial = yield* deployWorker(stack, "one", { count: 2 });
      const proxy = yield* transportProxy();
      const match = (event: { path: string }) =>
        event.path.endsWith("/uncordon");
      yield* Effect.sync(() => {
        endpoint = proxy.url;
        proxy.arm({ match, action: "drop-response", remaining: 1 });
        proxy.arm({ match, action: "cut-request", remaining: Infinity });
      });
      try {
        const failed = yield* deployWorker(stack, "two", { count: 2 }).pipe(
          Effect.timeout("120 seconds"),
          Effect.result,
        );
        expect(Result.isFailure(failed)).toBe(true);
        const lost = proxy.events.find(
          (event) =>
            event.stage === "dropped" && event.path.endsWith("/uncordon"),
        );
        expect(lost?.status).toBeGreaterThanOrEqual(200);
        expect(lost?.status).toBeLessThan(300);
        const live = yield* census(initial.appName);
        expect(
          initial.machineIds.every((id) =>
            live.some(
              (machine) => machine.id === id && machine.cordoned === false,
            ),
          ),
        ).toBe(true);
        expect(
          live.find((machine) => machine.id === lost!.machineId)?.cordoned,
        ).toBe(false);
        const candidateIds = live
          .filter((machine) => !initial.machineIds.includes(machine.id!))
          .map((machine) => machine.id!);
        expect(candidateIds).toHaveLength(2);
        expect(
          proxy.events.some(
            (event) =>
              event.method === "DELETE" &&
              /\/machines\/[^/]+$/.test(event.path) &&
              candidateIds.includes(event.machineId!),
          ),
        ).toBe(false);
        yield* Effect.sync(proxy.clear);
        const recovered = yield* deployWorker(stack, "two", { count: 2 });
        expect([...recovered.machineIds].sort()).toEqual(candidateIds.sort());
        yield* assertCommitted(initial.appName, recovered.machineIds);
      } finally {
        yield* Effect.sync(() => {
          endpoint = undefined;
          proxy.clear();
        });
      }
      yield* stack.destroy();
      yield* assertAppGone(initial.appName);
    }).pipe(
      Effect.scoped,
      Effect.ensuring(
        Effect.sync(() => {
          endpoint = undefined;
        }),
      ),
    ),
  { timeout: 300_000 },
);
