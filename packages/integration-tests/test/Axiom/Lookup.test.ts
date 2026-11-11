import * as Axiom from "@alchemy.run/axiom";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Core from "@alchemy.run/test/Core";
import * as Output from "alchemy/Output";
import * as Provider from "alchemy/Provider";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

const { test } = Test.make({ providers: Axiom.providers() });

const tags = ["provider:axiom", "provider:axiom:dataset", "provider:axiom:virtualfield", "live"];

// The target belongs to another stack, as a lookup's target always should.
const target = () => Core.scratchStack({ providers: Axiom.providers() }, "AxiomLookupTarget");

describe.sequential("lookup", () => {
  test.provider(
    "a looked-up Dataset holds a declared VirtualField and survives its destroy",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const owner = target();
        yield* owner.destroy();
        const dataset = yield* owner.deploy(
          Axiom.Dataset("LookupTarget", { name: "alchemy-test-lookup-target" }),
        );

        const program = Axiom.VirtualField("OnLookedUpDataset", {
          dataset: Axiom.Dataset.lookup({ name: dataset.name }).name,
          name: "lookup_status_class",
          expression: 'strcat(tostring(toint(status / 100)), "xx")',
          type: "string",
        });
        const field = yield* stack.deploy(program);
        expect(field.dataset).toEqual(dataset.name);

        // A lookup re-resolves to the same Dataset.
        const plan = yield* stack.plan(program);
        expect(plan.resources.OnLookedUpDataset?.action).toEqual("noop");

        // Destroying the consumer removes the field, never the Dataset.
        yield* stack.destroy();
        const datasets = yield* (yield* Provider.findProvider(Axiom.Dataset)).list();
        expect(datasets.some((d) => d.name === dataset.name)).toBe(true);

        yield* owner.destroy();
      }),
    { tags, timeout: 180_000 },
  );

  test.provider(
    "a lookup of a resource that doesn't exist fails the plan",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const lookups = {
          Dataset: Axiom.Dataset.lookup({ name: "alchemy-lookup-missing" }),
          Dashboard: Axiom.Dashboard.lookup({ uid: "alchemy-lookup-missing" }),
          View: Axiom.View.lookup({ id: "alchemy-lookup-missing" }),
          Notifier: Axiom.Notifier.lookup({ id: "alchemy-lookup-missing" }),
          Monitor: Axiom.Monitor.lookup({ id: "alchemy-lookup-missing" }),
          VirtualField: Axiom.VirtualField.lookup({ id: "alchemy-lookup-missing" }),
        } as unknown as Record<string, Output.Output<unknown>>;

        const mismatches: Record<string, string> = {};
        for (const [id, lookup] of Object.entries(lookups)) {
          const exit = yield* Effect.exit(
            stack.plan(
              Axiom.Dataset(id, {
                name: `alchemy-lookup-probe-${id.toLowerCase()}`,
                description: Output.interpolate`${lookup}`,
              }),
            ),
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
