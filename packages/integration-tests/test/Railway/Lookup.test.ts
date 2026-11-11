import * as Railway from "@alchemy.run/railway";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Core from "@alchemy.run/test/Core";
import { Query } from "@distilled.cloud/core/query";
import { Railway as RailwaySdk } from "@distilled.cloud/railway";
import * as Output from "alchemy/Output";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { railwayApi } from "./limit.ts";

const { test } = Test.make({ limit: railwayApi, providers: Railway.providers() });

const tags = ["provider:railway", "provider:railway:project", "live"];

// The target belongs to another stack, as a lookup's target always should.
const target = () => Core.scratchStack({ providers: Railway.providers() }, "RailwayLookupTarget");

// Well-formed ids nothing has.
const missing = "00000000-0000-4000-8000-000000000000";

describe.concurrent("lookup", () => {
  test.provider(
    "a looked-up Project holds a declared Environment and survives its destroy",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const owner = target();
        yield* owner.destroy();
        const project = yield* owner.deploy(Railway.Project("LookupTarget"));

        const program = Railway.Environment("InLookedUpProject", {
          project: Railway.Project.lookup({ projectId: project.projectId }),
        });
        const environment = yield* stack.deploy(program);
        expect(environment.projectId).toEqual(project.projectId);

        // A lookup re-resolves to the same Project.
        const plan = yield* stack.plan(program);
        expect(plan.resources.InLookedUpProject?.action).toEqual("noop");

        // Destroying the consumer removes the Environment, never the Project.
        yield* stack.destroy();
        const after = yield* readProjectDeletedAt(project.projectId);
        expect(after.deletedAt).toBeNull();

        yield* owner.destroy();
      }),
    { tags, timeout: 300_000 },
  );

  test.provider(
    "a lookup of a resource that doesn't exist fails the plan",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const owner = target();
        yield* owner.destroy();
        // Children are looked up in a project that exists, so only the
        // child itself is missing.
        const project = yield* owner.deploy(Railway.Project("LookupMissingTarget"));
        const { projectId, environmentId } = project;

        const lookups = {
          Project: Railway.Project.lookup({ projectId: missing }),
          Environment: Railway.Environment.lookup({ projectId, environmentId: missing }),
          Postgres: Railway.Postgres.lookup({ projectId, environmentId, serviceId: missing }),
          MySQL: Railway.MySQL.lookup({ projectId, environmentId, serviceId: missing }),
          Redis: Railway.Redis.lookup({ projectId, environmentId, serviceId: missing }),
          Mongo: Railway.Mongo.lookup({ projectId, environmentId, serviceId: missing }),
          Bucket: Railway.Bucket.lookup({ projectId, environmentId, bucketId: missing }),
          Volume: Railway.Volume.lookup({ projectId, environmentId, volumeId: missing }),
        } as unknown as Record<string, Output.Output<unknown>>;

        const mismatches: Record<string, string> = {};
        for (const [id, lookup] of Object.entries(lookups)) {
          const exit = yield* Effect.exit(
            stack.plan(Railway.Project(id, { description: Output.interpolate`${lookup}` })),
          );
          const pretty = Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "plan succeeded";
          if (!pretty.includes("LookupNotFoundError")) {
            mismatches[id] = pretty.split("\n")[0]!.slice(0, 300);
          }
        }
        expect(mismatches).toEqual({});

        yield* owner.destroy();
      }),
    { tags, timeout: 300_000 },
  );
});

/** A project's deletion time, read from Railway: `null` while it exists. */
const readProjectDeletedAt = Query.fn((id: string) => ({
  deletedAt: RailwaySdk.project({ id }).deletedAt,
}));
