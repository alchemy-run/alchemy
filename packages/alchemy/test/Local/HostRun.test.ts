/**
 * The Host.run lifetime contract, proven against a REAL detached
 * process: a layer that registers a background fiber via
 * {@link Local.runOnHost} is provided with plain `Effect.provide` on
 * the constructor — the fiber must still be running when requests
 * arrive (long after init returned its handlers).
 */
import * as Alchemy from "@/index.ts";
import * as Local from "@/Local/index.ts";
import { inMemoryState } from "@/State";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import HostedApi from "./fixtures/hosted-service.ts";

const { test, deploy, destroy } = Test.make({
  providers: Local.providers(),
});

test(
  "runOnHost fibers survive Effect.provide of the constructor impl",
  Effect.gen(function* () {
    const Stack = Alchemy.Stack(
      "ServerHostedServiceTest",
      { providers: Local.providers(), state: inMemoryState() },
      Effect.gen(function* () {
        const api = yield* HostedApi;
        return { url: api.url.as<string | undefined>() };
      }),
    );

    const out = yield* deploy(Stack);
    yield* Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const response = yield* client.get(`${out.url}/`).pipe(
        Effect.retry({
          schedule: Schedule.exponential("200 millis"),
          times: 12,
        }),
      );
      expect(response.status).toBe(200);
      const body = (yield* response.json) as {
        before: number;
        after: number;
        alive: boolean;
      };
      expect(body.alive).toBe(true);
    }).pipe(Effect.ensuring(Effect.orDie(destroy(Stack))));
  }),
  { timeout: 60_000 },
);
