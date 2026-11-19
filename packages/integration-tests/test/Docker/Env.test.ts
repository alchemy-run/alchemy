import * as Docker from "@alchemy.run/docker";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { inMemoryState } from "alchemy/State";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Schedule from "effect/Schedule";
import { expectedEnv } from "../EnvValues.ts";
import EnvService, { ENV_EXTERNAL_PORT } from "./fixtures/env-service.ts";
import { ensureDockerSwarm } from "./Runtime.ts";

const { test } = Test.make({ providers: Docker.providers(), state: inMemoryState() });

test.provider(
  "Service deploys every env value as the string the process reads",
  (stack) =>
    Effect.gen(function* () {
      yield* ensureDockerSwarm;
      yield* stack.destroy();

      yield* stack.deploy(
        Effect.gen(function* () {
          return yield* EnvService;
        }),
      );

      const body = yield* HttpClient.get(`http://localhost:${ENV_EXTERNAL_PORT}/env`).pipe(
        Effect.flatMap((res) =>
          res.status === 200 ? res.json : Effect.fail(new Error(`/env returned ${res.status}`)),
        ),
        Effect.timeout("10 seconds"),
        Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 30 }),
        Effect.ensuring(stack.destroy().pipe(Effect.ignore)),
      );
      expect(body).toEqual(expectedEnv);
    }),
  {
    tags: ["provider:docker", "provider:docker:service", "local"],
    timeout: 300_000,
  },
);
