import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as rules from "@distilled.cloud/cloudflare/rules";
import * as Alchemy from "alchemy";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import { expectDeployFails, missingName } from "../../lookup.ts";
import { expectUrlContains } from "../Utils/Http.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

const tags = ["provider:cloudflare", "provider:cloudflare:rules", "live"];

// Rulesets that reference a list are account or zone phase singletons other
// suites own, so a Worker receives the rule expression built from the
// looked-up list instead.
const callerScript = `export default {
  async fetch(request, env) {
    return new Response(env.EXPRESSION);
  },
};`;

// The target belongs to another stack, as a lookup's target always should.
const TargetStack = Alchemy.Stack(
  "RulesListLookupTarget",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const list = yield* Cloudflare.Rules.List("lookup-target", { kind: "ip" });
    return { listId: list.listId.as<string>(), name: list.name.as<string>() };
  }),
);

const target = beforeAll(deploy(TargetStack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(TargetStack));

test.provider(
  "a looked-up list names a rule expression, by name and by id",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { accountId } = yield* yield* CloudflareEnvironment;
      const { listId, name } = yield* target;

      const program = Effect.gen(function* () {
        const list = Cloudflare.Rules.List.lookup({ name });
        const byId = Cloudflare.Rules.List.lookup({ listId });
        const caller = yield* Cloudflare.Worker("list-lookup-caller", {
          script: callerScript,
          workersDev: true,
          env: { EXPRESSION: Output.interpolate`ip.src in $${list.name}` },
        });
        return { url: caller.url.as<string>(), listId: list.listId, kind: byId.kind };
      });
      const out = yield* stack.deploy(program);
      expect(out.listId).toBe(listId);
      expect(out.kind).toBe("ip");

      yield* expectUrlContains(out.url, `ip.src in $${name}`, { label: "list lookup caller" });

      // A lookup re-resolves to the same list, so nothing changes.
      const plan = yield* stack.plan(program);
      expect(plan.resources["list-lookup-caller"].action).toBe("noop");

      // Destroying the stack that looked it up leaves the list alone.
      yield* stack.destroy();
      const survivor = yield* rules.getList({ accountId, listId });
      expect(survivor.name).toBe(name);
    }),
  { tags, timeout: 180_000 },
);

test.provider(
  "a lookup of a missing list fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage).replaceAll("-", "_");
      yield* expectDeployFails(
        stack.deploy(
          Cloudflare.Worker("list-lookup-missing", {
            script: callerScript,
            env: { EXPRESSION: Cloudflare.Rules.List.lookup({ name }).name },
          }),
        ),
        ["LookupNotFoundError", name],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a lookup of a list this stack manages fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const managed = () => Cloudflare.Rules.List("lookup-managed", { kind: "ip" });
      const { name } = yield* stack.deploy(managed());
      yield* expectDeployFails(
        stack.deploy(
          Effect.gen(function* () {
            yield* managed();
            yield* Cloudflare.Worker("list-lookup-managed-caller", {
              script: callerScript,
              env: { EXPRESSION: Cloudflare.Rules.List.lookup({ name }).name },
            });
          }),
        ),
        ["LookupOfManagedResourceError", "lookup-managed"],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);
