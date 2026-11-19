import * as Daytona from "@alchemy.run/daytona";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as sandboxes from "@distilled.cloud/daytona/sandbox";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Schedule from "effect/Schedule";
import { expectedEnv } from "../EnvValues.ts";
import EnvAgent from "./fixtures/program/env.ts";

const { test } = Test.make({ providers: Daytona.providers() });

test.provider(
  "a sandbox program reads env values as process env strings",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const agent = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* EnvAgent;
        }),
      );

      // Retry while the preview proxy warms up.
      const env = yield* HttpClient.get(agent.url!).pipe(
        Effect.flatMap((res) =>
          res.status === 200
            ? res.json
            : Effect.flatMap(res.text, (text) => Effect.fail(new Error(`${res.status}: ${text}`))),
        ),
        Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 15 }),
      );

      // Assert after destroy so a failure leaves nothing deployed.
      yield* stack.destroy();
      const state = yield* sandboxes.getSandbox({ sandboxIdOrName: agent.sandboxId }).pipe(
        Effect.map((s) => s.state),
        Effect.catchTag("SandboxNotFound", () => Effect.succeed("gone" as const)),
        Effect.repeat({
          schedule: Schedule.spaced("2 seconds"),
          until: (state) => state === "gone" || state === "destroyed",
          times: 30,
        }),
      );
      expect(env).toEqual(expectedEnv);
      expect(state).toMatch(/gone|destroyed/);
    }),
  { tags: ["provider:daytona", "provider:daytona:sandbox", "live"], timeout: 600_000 },
);
