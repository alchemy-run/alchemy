import * as AWS from "@alchemy.run/aws";
import * as Modal from "@alchemy.run/modal";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { expectedEnv, getJson } from "../EnvValues.ts";
import EnvFunction from "./fixtures/env-function.ts";
import { hostIdentity } from "./hostIdentity.ts";

const { test } = Test.make({
  providers: Layer.mergeAll(Modal.providers(), AWS.providers(), hostIdentity),
});

test.provider(
  "a sandbox program reads env values as process env strings",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const host = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* EnvFunction;
        }),
      );

      const env = yield* getJson(host.functionUrl!);

      // Assert after destroy so a failure leaves nothing deployed.
      yield* stack.destroy();
      expect(env).toEqual(expectedEnv);
    }),
  {
    tags: ["provider:modal", "provider:modal:sandbox", "provider:aws", "live"],
    timeout: 600_000,
  },
);
