import * as AWS from "@/AWS";
import { destroy } from "@/Destroy";
import { test } from "@/Test/Vitest";
import * as Effect from "effect/Effect";

import Function from "./handler";

test(
  "create, update, delete function",
  { timeout: 180_000 },
  Effect.gen(function* () {
    yield* destroy();

    yield* test.deploy(
      Effect.gen(function* () {
        return yield* Function;
      }),
    );

    yield* destroy();
  }).pipe(Effect.provide(AWS.providers())) as Effect.Effect<void, any, any>,
);
