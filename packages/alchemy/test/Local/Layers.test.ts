/**
 * The constructor-LAYERS lifetime contract, proven against a REAL
 * detached process: a layer that owns a background fiber (forked into
 * its build scope) is declared as the class's `layers` argument —
 * the fiber must still be running when requests arrive (long after
 * init returned its handlers), and an inline `Effect.provide` of the
 * same layer reference must dedupe into the one instance-lifetime
 * build (`builds === 1`, same service instance).
 */
import * as Alchemy from "@/index.ts";
import * as Local from "@/Local/index.ts";
import { inMemoryState } from "@/State";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import LayeredApi from "./fixtures/layered-service.ts";

const { test, deploy, destroy } = Test.make({
  providers: Local.providers(),
});

test(
  "constructor layers live for the instance; inline provide dedupes",
  Effect.gen(function* () {
    const Stack = Alchemy.Stack(
      "ServerLayeredServiceTest",
      { providers: Local.providers(), state: inMemoryState() },
      Effect.gen(function* () {
        const api = yield* LayeredApi;
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
        builds: number;
        sameInstance: boolean;
        before: number;
        after: number;
        alive: boolean;
      };
      // the layer's background fiber survived init returning
      expect(body.alive).toBe(true);
      // the inline Effect.provide reused the class-level build
      expect(body.builds).toBe(1);
      expect(body.sameInstance).toBe(true);
    }).pipe(Effect.ensuring(Effect.orDie(destroy(Stack))));
  }),
  { timeout: 60_000 },
);
