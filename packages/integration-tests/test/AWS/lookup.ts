import * as AWS from "@alchemy.run/aws";
import { expect } from "@alchemy.run/test";
import type { ScratchStack } from "@alchemy.run/test/Alchemy";
import * as ssm from "@distilled.cloud/aws/ssm";
import type { Input } from "alchemy/Input";
import * as Output from "alchemy/Output";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Redacted from "effect/Redacted";

/**
 * Deploy one SSM parameter per looked-up value, each holding the value it
 * was given, and check:
 *
 * - every parameter holds the value `expected` names, read back from SSM;
 * - a second plan of the same program is a noop (a lookup re-resolves to
 *   the same resource);
 * - destroying the stack removes the parameters and nothing else.
 *
 * `values` is a thunk so each deploy and plan builds fresh lookups.
 */
export const expectLookupConsumers = Effect.fn(function* (
  stack: ScratchStack,
  values: () => Record<string, Input<string>>,
  expected: Record<string, string>,
) {
  const program = Effect.gen(function* () {
    // Resolved to the parameter names by the deploy.
    const names: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(values())) {
      const parameter = yield* AWS.SSM.Parameter(`lookup-${key}`, { value });
      names[key] = parameter.parameterName;
    }
    return names;
  });

  const names = yield* stack.deploy(program);
  for (const [key, name] of Object.entries(names)) {
    const { Parameter } = yield* ssm.getParameter({ Name: name as string });
    const value = Parameter?.Value;
    expect({ [key]: Redacted.isRedacted(value) ? Redacted.value(value) : value }).toEqual({
      [key]: expected[key],
    });
  }

  const plan = yield* stack.plan(program);
  for (const key of Object.keys(names)) {
    expect({ [key]: plan.resources[`lookup-${key}`]?.action }).toEqual({ [key]: "noop" });
  }

  yield* stack.destroy();
});

/**
 * Deploy one SSM parameter per lookup of a resource that doesn't exist, and
 * check every deploy fails with `LookupNotFoundError`. Every lookup is tried,
 * and the assertion names each one that failed some other way.
 */
export const expectAllMissing = Effect.fn(function* (
  stack: ScratchStack,
  lookups: Record<string, Output.Output<unknown>>,
) {
  const mismatches: Record<string, string> = {};
  for (const [id, value] of Object.entries(lookups)) {
    const exit = yield* Effect.exit(
      stack.deploy(AWS.SSM.Parameter(id, { value: Output.interpolate`${value}` })),
    );
    const pretty = Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "deploy succeeded";
    if (!pretty.includes("LookupNotFoundError")) {
      mismatches[id] = pretty.split("\n")[0]!.slice(0, 300);
    }
  }
  expect(mismatches).toEqual({});
  yield* stack.destroy();
});
