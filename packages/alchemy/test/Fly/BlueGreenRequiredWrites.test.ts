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

const props = {
  count: 2,
  deploy: { strategy: "bluegreen", healthTimeout: "90 seconds" },
} as const;

test.provider(
  "F05 real required promotion-intent write fault forbids every uncordon and early old deletion",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const initial = yield* deployWorker(stack, "one", props);
      const proxy = yield* transportProxy();
      try {
        yield* Effect.sync(() => {
          endpoint = proxy.url;
          proxy.arm({
            match: (event) =>
              event.method === "PUT" &&
              event.path.endsWith("/metadata") &&
              event.phase === "promoting",
            action: "cut-request",
            remaining: Infinity,
          });
        });
        const result = yield* deployWorker(stack, "two", props).pipe(
          Effect.result,
        );
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result))
          expect(result.failure).toMatchObject({
            _tag: "Fly.MachineMutationUncertain",
          });
        const cut = proxy.events.filter(
          (event) => event.stage === "cut" && event.phase === "promoting",
        );
        expect(cut.length).toBeGreaterThan(0);
        expect(new Set(cut.map((event) => event.machineId)).size).toBe(1);
        const live = yield* census(initial.appName);
        const old = live.filter((machine) =>
          initial.machineIds.includes(machine.id!),
        );
        const candidates = live.filter(
          (machine) => !initial.machineIds.includes(machine.id!),
        );
        expect(old.map((machine) => machine.id).sort()).toEqual(
          [...initial.machineIds].sort(),
        );
        expect(
          old.every(
            (machine) =>
              machine.cordoned === false && machine.state === "started",
          ),
        ).toBe(true);
        expect(candidates).toHaveLength(2);
        expect(
          candidates.every(
            (machine) =>
              machine.cordoned === true &&
              machine.config?.metadata?.["alchemy.phase"] === "candidate",
          ),
        ).toBe(true);
        expect(
          candidates.some((machine) => machine.id === cut[0]!.machineId),
        ).toBe(true);
        expect(
          proxy.events.some((event) => event.path.endsWith("/uncordon")),
        ).toBe(false);
        expect(
          proxy.events.some(
            (event) =>
              initial.machineIds.includes(event.machineId!) &&
              (event.path.endsWith("/cordon") ||
                event.path.endsWith("/stop") ||
                (event.method === "DELETE" &&
                  /\/machines\/[^/]+$/.test(event.path))),
          ),
        ).toBe(false);
        expect(
          proxy.events.some(
            (event) => event.phase === "active" || event.phase === "retiring",
          ),
        ).toBe(false);
        expect(
          proxy.events.some(
            (event) =>
              event.method === "DELETE" &&
              /\/machines\/[^/]+$/.test(event.path),
          ),
        ).toBe(false);
        const candidateIds = candidates.map((machine) => machine.id!).sort();
        yield* Effect.sync(proxy.clear);
        const recovered = yield* deployWorker(stack, "two", props);
        expect([...recovered.machineIds].sort()).toEqual(candidateIds);
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
  { timeout: 900_000 },
);
