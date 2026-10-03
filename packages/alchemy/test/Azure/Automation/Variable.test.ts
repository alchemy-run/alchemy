import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as automation from "@distilled.cloud/azure/automation";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import {
  account,
  logLevel,
  subscription,
  tags,
  waitGone,
  sharedAccountTest,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const program = (props: {
  value: unknown;
  isEncrypted?: boolean;
  description?: string;
}) =>
  Effect.gen(function* () {
    const { where } = yield* account;
    const variable = yield* Azure.Automation.Variable("Variable", {
      ...where,
      value: props.value,
      isEncrypted: props.isEncrypted,
      description: props.description,
    });
    return { where, variable };
  });

const getVariable = (
  resourceGroupName: string,
  automationAccountName: string,
  variableName: string,
) =>
  Effect.gen(function* () {
    return yield* automation.GetVariable({
      subscriptionId: yield* subscription,
      resourceGroupName,
      automationAccountName,
      variableName,
    });
  });

// Free: an Automation account plus one variable, seconds to provision.
test.provider(
  "create, update, replace, and delete a variable",
  (stack) =>
    sharedAccountTest(stack)(
      Effect.gen(function* () {
        yield* stack.destroy();

        const { where, variable } = yield* stack.deploy(
          program({ value: "hello", description: "one" }),
        );
        const get = (name: string) =>
          getVariable(where.resourceGroup, where.automationAccount, name);
        const observed = yield* get(variable.variableName);
        expect(observed.properties?.value).toEqual('"hello"');
        expect(observed.properties?.description).toEqual("one");

        // In-place: value and description.
        const updated = yield* stack.deploy(
          program({ value: { n: 2 }, description: "two" }),
        );
        expect(updated.variable.variableId).toEqual(variable.variableId);
        const reobserved = yield* get(variable.variableName);
        expect(JSON.parse(reobserved.properties?.value ?? "null")).toEqual({
          n: 2,
        });
        expect(reobserved.properties?.description).toEqual("two");

        // Replacement: encryption is immutable.
        const replaced = yield* stack.deploy(
          program({
            value: Redacted.make("secret"),
            isEncrypted: true,
            description: "two",
          }),
        );
        expect(replaced.variable.variableName).not.toEqual(
          variable.variableName,
        );
        const encrypted = yield* get(replaced.variable.variableName);
        expect(encrypted.properties?.isEncrypted).toEqual(true);
        expect(encrypted.properties?.value).toBeUndefined();
        expect(yield* waitGone(get(variable.variableName))).toEqual("gone");

        yield* stack.destroy();
        expect(yield* waitGone(get(replaced.variable.variableName))).toEqual(
          "gone",
        );
      }),
    ).pipe(logLevel),
  { tags, timeout: 600_000 },
);
