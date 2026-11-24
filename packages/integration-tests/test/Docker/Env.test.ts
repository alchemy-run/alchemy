import * as Docker from "@alchemy.run/docker";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { inMemoryState } from "alchemy/State";
import * as Effect from "effect/Effect";
import { expectedEnv, getJson } from "../EnvValues.ts";
import EnvService from "./fixtures/env-service.ts";
import { ensureDockerSwarm, publishedUrl } from "./Runtime.ts";

const { test } = Test.make({ providers: Docker.providers(), state: inMemoryState() });

test.provider(
  "Service deploys every env value as the string the process reads",
  (stack) =>
    Effect.gen(function* () {
      yield* ensureDockerSwarm;
      yield* stack.destroy();
      const service = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* EnvService;
        }),
      );
      const env = yield* getJson(publishedUrl(service.ports)).pipe(
        Effect.ensuring(stack.destroy().pipe(Effect.ignore)),
      );
      expect(env).toEqual(expectedEnv);
    }),
  { tags: ["provider:docker", "provider:docker:service", "local"], timeout: 300_000 },
);
