import * as AWS from "@/AWS";
import { destroy } from "@/index";
import { test } from "@/Test/Vitest";
import * as Effect from "effect/Effect";

import Function from "./handler";

test(
  "create, update, delete function",
  Effect.gen(function* () {
    test.deploy(
      Effect.gen(function* () {
        yield* Function;
      }),
    );

    yield* destroy();
  }).pipe(Effect.provide(AWS.providers())),
);
