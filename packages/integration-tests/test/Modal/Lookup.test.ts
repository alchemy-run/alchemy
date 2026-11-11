import * as Modal from "@alchemy.run/modal";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Output from "alchemy/Output";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

const { test } = Test.make({ providers: Modal.providers() });

const tags = ["provider:modal", "provider:modal:app", "live"];

describe.sequential("lookup", () => {
  test.provider(
    "a lookup of a resource that doesn't exist fails the plan",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const name = "alchemy-lookup-missing";
        const lookups = {
          App: Modal.App.lookup({ name }),
          Volume: Modal.Volume.lookup({ name }),
          Dict: Modal.Dict.lookup({ name }),
          Queue: Modal.Queue.lookup({ name }),
          Secret: Modal.Secret.lookup({ name }),
          Environment: Modal.Environment.lookup({ name }),
        } as unknown as Record<string, Output.Output<unknown>>;

        const mismatches: Record<string, string> = {};
        for (const [id, lookup] of Object.entries(lookups)) {
          const exit = yield* Effect.exit(
            stack.plan(Modal.App(id, { tags: { value: Output.interpolate`${lookup}` } })),
          );
          const pretty = Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "plan succeeded";
          if (!pretty.includes("LookupNotFoundError")) {
            mismatches[id] = pretty.split("\n")[0]!.slice(0, 300);
          }
        }
        expect(mismatches).toEqual({});
      }),
    { tags, timeout: 120_000 },
  );
});
