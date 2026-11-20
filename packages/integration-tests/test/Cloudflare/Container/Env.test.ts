import * as Cloudflare from "@alchemy.run/cloudflare";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { expectedEnv } from "../../EnvValues.ts";
import EnvContainerStack from "./fixtures/env/stack.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const stack = beforeAll(deploy(EnvContainerStack), { timeout: 600_000 });
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(EnvContainerStack), { timeout: 600_000 });

test(
  "Container deploys every env value as the string the process reads",
  Effect.gen(function* () {
    const { url } = yield* stack;
    // Fresh connection per attempt so a retry can land on an edge that has
    // the new deploy; retry through worker propagation and container boot.
    const client = (yield* HttpClient.HttpClient).pipe(
      HttpClient.mapRequest(HttpClientRequest.setHeader("connection", "close")),
    );
    const body = yield* client.get(new URL("/env", url)).pipe(
      Effect.flatMap((res) =>
        res.status === 200
          ? res.json
          : res.text.pipe(
              Effect.flatMap((text) => Effect.fail(new Error(`${res.status}: ${text}`))),
            ),
      ),
      Effect.timeout("15 seconds"),
      Effect.retry({
        schedule: Schedule.min([Schedule.exponential("500 millis"), Schedule.spaced("3 seconds")]),
        times: 60,
      }),
    );
    expect(body).toEqual(expectedEnv);
  }).pipe(logLevel),
  {
    tags: ["provider:cloudflare", "provider:cloudflare:containers", "live"],
    timeout: 300_000,
  },
);
