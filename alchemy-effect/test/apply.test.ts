import * as Effect from "effect/Effect";

import { apply } from "@/apply";
import { destroy } from "@/destroy";
import * as Output from "@/output";
import { State } from "@/state";
import { test } from "@/test";
import { expect } from "@effect/vitest";
import { TestLayers, TestResource } from "./test.resources.ts";

test(
  "apply should create when non-existent and update when props change",
  Effect.gen(function* () {
    {
      class A extends TestResource("A", {
        string: "test-string",
      }) {}

      const stack = yield* apply(A);
      expect(stack.A.string).toEqual("test-string");
    }

    {
      class A extends TestResource("A", {
        string: "test-string-new",
      }) {}

      const stack = yield* apply(A);
      expect(stack.A.string).toEqual("test-string-new");
    }

    yield* destroy();

    const state = yield* State;

    yield* state.get("A");
    expect(yield* state.get("A")).toBeUndefined();

    expect(yield* state.list()).toEqual([]);
  }).pipe(Effect.provide(TestLayers)),
);

test(
  "apply should resolve output properties",
  Effect.gen(function* () {
    class A extends TestResource("A", {
      string: "test-string",
      stringArray: ["test-string-array"],
    }) {}
    {
      class B extends TestResource("B", {
        string: Output.of(A).string,
      }) {}

      const stack = yield* apply(B);
      expect(stack.B.string).toEqual("test-string");
    }

    {
      class B extends TestResource("B", {
        string: Output.of(A).string.apply((string) => string.toUpperCase()),
      }) {}

      const stack = yield* apply(B);
      expect(stack.B.string).toEqual("TEST-STRING");
    }

    {
      class B extends TestResource("B", {
        string: Output.of(A).string.effect((string) =>
          Effect.succeed(string.toUpperCase() + "-NEW"),
        ),
      }) {}

      const stack = yield* apply(B);
      expect(stack.B.string).toEqual("TEST-STRING-NEW");
    }

    {
      class B extends TestResource("B", {
        string: Output.of(A)
          .string.apply((string) => string.toUpperCase())
          .apply((string) => string + "-CALL-EXPR"),
      }) {}

      const stack = yield* apply(B);
      expect(stack.B.string).toEqual("TEST-STRING-CALL-EXPR");
    }

    {
      class B extends TestResource("B", {
        stringArray: Output.of(A).stringArray,
      }) {}

      const stack = yield* apply(B);
      expect(stack.B.stringArray).toEqual(["test-string-array"]);
    }

    {
      class B extends TestResource("B", {
        string: Output.of(A).stringArray[0],
      }) {}

      const stack = yield* apply(B);
      expect(stack.B.string).toEqual("test-string-array");
    }

    {
      class B extends TestResource("B", {
        string: Output.of(A).stringArray[0].apply((string) =>
          string.toUpperCase(),
        ),
      }) {}

      const stack = yield* apply(B);
      expect(stack.B.string).toEqual("TEST-STRING-ARRAY");
    }

    {
      class B extends TestResource("B", {
        stringArray: Output.of(A).stringArray.apply((string) =>
          string.map((string) => string.toUpperCase()),
        ),
      }) {}

      const stack = yield* apply(B);
      expect(stack.B.stringArray).toEqual(["TEST-STRING-ARRAY"]);
    }

    {
      class B extends TestResource("B", {
        stringArray: Output.of(A).stringArray.apply((stringArray) =>
          stringArray.flatMap((string) => [string, string]),
        ),
      }) {}

      const stack = yield* apply(B);
      expect(stack.B.stringArray).toEqual([
        "test-string-array",
        "test-string-array",
      ]);
    }
  }).pipe(Effect.provide(TestLayers)),
);
