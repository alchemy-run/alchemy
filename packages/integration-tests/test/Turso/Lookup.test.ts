import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Core from "@alchemy.run/test/Core";
import * as Turso from "@alchemy.run/turso";
import { organization } from "@alchemy.run/turso/Credentials";
import * as turso from "@distilled.cloud/turso/turso";
import * as Output from "alchemy/Output";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

const { test } = Test.make({ providers: Turso.providers() });

const tags = ["provider:turso", "provider:turso:group", "provider:turso:database", "live"];

// The target belongs to another stack, as a lookup's target always should.
const target = () => Core.scratchStack({ providers: Turso.providers() }, "TursoLookupTarget");

describe.concurrent("lookup", () => {
  test.provider(
    "a looked-up Group holds a declared Database and survives its destroy",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const owner = target();
        yield* owner.destroy();
        const group = yield* owner.deploy(Turso.Group("LookupTarget"));

        const program = Turso.Database("InLookedUpGroup", {
          group: Turso.Group.lookup({ name: group.name }).name,
        });
        const db = yield* stack.deploy(program);
        expect(db.group).toEqual(group.name);

        // A lookup re-resolves to the same Group.
        const plan = yield* stack.plan(program);
        expect(plan.resources.InLookedUpGroup?.action).toEqual("noop");

        // Destroying the consumer removes the Database, never the Group.
        yield* stack.destroy();
        const org = yield* organization;
        const after = yield* turso.getGroup({ organizationSlug: org, groupName: group.name });
        expect(after.group?.name).toEqual(group.name);
        const gone = yield* turso
          .getDatabase({ organizationSlug: org, databaseName: db.name })
          .pipe(
            Effect.as("found" as const),
            Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
          );
        expect(gone).toEqual("gone");

        yield* owner.destroy();
      }),
    { tags, timeout: 300_000 },
  );

  test.provider(
    "a lookup of a resource that doesn't exist fails the plan",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const lookups = {
          Group: Turso.Group.lookup({ name: "alchemy-missing-group" }),
          Database: Turso.Database.lookup({ name: "alchemy-missing-db" }),
        } as unknown as Record<string, Output.Output<unknown>>;

        const mismatches: Record<string, string> = {};
        for (const [id, lookup] of Object.entries(lookups)) {
          const exit = yield* Effect.exit(
            stack.plan(Turso.Group(id, { location: Output.interpolate`${lookup}` })),
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
