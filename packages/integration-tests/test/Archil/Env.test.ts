import * as Archil from "@alchemy.run/archil";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as archil from "@distilled.cloud/archil";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Schedule from "effect/Schedule";
import { expectedEnv } from "../EnvValues.ts";
import EnvApi from "./fixtures/program/env.ts";

const { test } = Test.make({ providers: Archil.providers() });

test.provider(
  "a sandbox program reads env values as process env strings",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const api = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* EnvApi;
        }),
      );

      const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);
      const env = yield* client.get(`${api.url}/`).pipe(
        Effect.flatMap((res) => res.json),
        // A fresh hostname or a waking sandbox can take a few seconds.
        Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 20 }),
      );

      // Assert after destroy so a failure leaves nothing deployed.
      yield* stack.destroy();
      const gone = yield* archil.getSandbox({ sid: api.sandboxId }).pipe(
        Effect.map(({ data }) => data.status === "deleted"),
        Effect.catchTag("NotFound", () => Effect.succeed(true)),
      );
      expect(env).toEqual(expectedEnv);
      expect(gone).toBe(true);
    }),
  { tags: ["provider:archil", "provider:archil:sandbox", "live"], timeout: 600_000 },
);
