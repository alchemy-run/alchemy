import * as machines from "@distilled.cloud/fly-io/machines";
import * as Retry from "@distilled.cloud/fly-io/Retry";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import {
  assertAppGone,
  assertCommitted,
  deployWorker,
} from "./fixtures/bluegreen.ts";
import { throughProxy, transportProxy } from "./fixtures/transport.ts";

let endpoint: string | undefined;
const { test } = Test.make({ providers: throughProxy(() => endpoint) });

test.provider(
  "F02 lost completed create reuses the same owned name and real Conflict",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const initial = yield* deployWorker(stack, "one");
      const proxy = yield* transportProxy();
      yield* Effect.sync(() => {
        endpoint = proxy.url;
        proxy.arm({
          match: (event) =>
            event.method === "POST" && event.path.endsWith("/machines"),
          action: "drop-response",
          remaining: 1,
        });
      });
      try {
        const next = yield* deployWorker(stack, "two");
        const created = proxy.events.filter(
          (event) =>
            event.stage === "completed" &&
            event.method === "POST" &&
            event.path.endsWith("/machines") &&
            event.status! < 300,
        );
        expect(created).toHaveLength(1);
        expect(next.machineIds).toEqual([created[0]!.machineId]);
        expect(next.machineId).not.toBe(initial.machineId);
        expect(
          proxy.events.filter((event) => event.stage === "dropped"),
        ).toHaveLength(1);
        const live = yield* assertCommitted(next.appName, next.machineIds);
        const conflict = yield* machines
          .createMachine({
            app_name: next.appName,
            name: live[0]!.name,
            region: live[0]!.region,
            config: live[0]!.config,
          })
          .pipe(Retry.none, Effect.result);
        expect(Result.isFailure(conflict)).toBe(true);
        if (Result.isFailure(conflict))
          expect(conflict.failure._tag).toBe("Conflict");
        yield* assertCommitted(next.appName, next.machineIds);
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
