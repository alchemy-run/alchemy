import { $ } from "@/index";
import * as AWS from "@/aws";
import * as DynamoDB from "@/aws/dynamodb";
import * as Lambda from "@/aws/lambda";
import { apply, destroy, type } from "@/index";
import { test } from "@/test";
import { expect } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as S from "effect/Schema";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "..", "..", "handler.ts");

test(
  "create, update, delete function",
  Effect.gen(function* () {
    const lambda = yield* Lambda.LambdaClient;

    class MyFunction extends Lambda.serve("MyFunction", {
      fetch: Effect.fn(function* (event) {
        return {
          body: "Hello, world!",
        };
      }),
    })({
      main,
      bindings: $(),
    }) {}

    const stack = yield* apply(MyFunction);

    yield* destroy();
  }).pipe(Effect.provide(AWS.live)),
);
