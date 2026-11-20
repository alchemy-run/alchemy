import * as Prisma from "@alchemy.run/prisma";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Core from "@alchemy.run/test/Core";
import { getDatabase, getProject } from "@distilled.cloud/prisma/management";
import * as Output from "alchemy/Output";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

const { test } = Test.make({ providers: Prisma.providers() });

const tags = ["provider:prisma", "provider:prisma:project", "provider:prisma:database", "live"];

// The target belongs to another stack, as a lookup's target always should.
const target = () => Core.scratchStack({ providers: Prisma.providers() }, "PrismaLookupTarget");

describe.concurrent("lookup", () => {
  test.provider(
    "a looked-up Project holds a declared Database and survives its destroy",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const owner = target();
        yield* owner.destroy();
        const project = yield* owner.deploy(
          Prisma.Project("LookupTarget", { createDatabase: false }),
        );

        const program = Prisma.Database("InLookedUpProject", {
          project: Prisma.Project.lookup({ projectId: project.projectId }),
        });
        const database = yield* stack.deploy(program);
        const stored = yield* getDatabase({ databaseId: database.databaseId });
        expect(stored.data.id).toEqual(database.databaseId);

        // A lookup re-resolves to the same Project.
        const plan = yield* stack.plan(program);
        expect(plan.resources.InLookedUpProject?.action).toEqual("noop");

        // Destroying the consumer removes the Database, never the Project.
        yield* stack.destroy();
        const after = yield* getProject({ id: project.projectId });
        expect(after.data.id).toEqual(project.projectId);

        yield* owner.destroy();
      }),
    { tags, timeout: 300_000 },
  );

  test.provider(
    "a lookup of a resource that doesn't exist fails the plan",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        // Well-formed ids nothing has: Prisma rejects a malformed one before
        // looking it up.
        const lookups = {
          Project: Prisma.Project.lookup({ projectId: "proj_zzzzzzzzzzzzzzzzzzzzzzzz" }),
          Database: Prisma.Database.lookup({ databaseId: "db_zzzzzzzzzzzzzzzzzzzzzzzz" }),
          Branch: Prisma.Branch.lookup({ branchId: "br_zzzzzzzzzzzzzzzzzzzzzzzz" }),
          App: Prisma.App.lookup({ appId: "cps_zzzzzzzzzzzzzzzzzzzzzzzz" }),
          Bucket: Prisma.Bucket.lookup({ bucketId: "bkt_zzzzzzzzzzzzzzzzzzzzzzzz" }),
        } as unknown as Record<string, Output.Output<unknown>>;

        const mismatches: Record<string, string> = {};
        for (const [id, lookup] of Object.entries(lookups)) {
          const exit = yield* Effect.exit(
            stack.plan(
              Prisma.Project(id, {
                createDatabase: false,
                settings: { value: Output.interpolate`${lookup}` },
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
