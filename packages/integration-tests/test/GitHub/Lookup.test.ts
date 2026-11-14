import * as GitHub from "@alchemy.run/github";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Core from "@alchemy.run/test/Core";
import * as Issues from "@distilled.cloud/github/issues";
import { adopt } from "alchemy/AdoptPolicy";
import * as Output from "alchemy/Output";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { gh } from "./scope.ts";

const providers = () => GitHub.providers({ baseUrl: "github.com" });

const { test } = Test.make({ providers: providers() });

const tags = ["provider:github", "provider:github:repository", "provider:github:label", "live"];

const owner = "alchemy-run-test";

// The target belongs to another stack, as a lookup's target always should.
// The test token can't delete repositories, so the repository is kept and
// adopted on the next run.
const target = () => Core.scratchStack({ providers: providers() }, "GitHubLookupTarget");

describe.sequential("lookup", () => {
  test.provider(
    "a looked-up Repository holds a declared Label",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const name = `lookup-${stack.stage}`.replace(/[^a-zA-Z0-9-]/g, "-").slice(0, 90);
        const repo = yield* target().deploy(
          GitHub.Repository("LookupTarget", {
            owner,
            name,
            visibility: "public",
            autoInit: true,
          }).pipe(adopt(true)),
        );

        const program = GitHub.Label("OnLookedUpRepository", {
          owner,
          repository: GitHub.Repository.lookup({ owner, name }).fullName.pipe(
            Output.map((fullName) => fullName.split("/")[1]!),
          ),
          name: "looked-up",
          color: "0e8a16",
        });
        const label = yield* stack.deploy(program);
        const stored = yield* gh(Issues.getLabel({ owner, repo: name, name: "looked-up" }));
        expect(stored.id).toEqual(label.labelId);
        expect(repo.fullName).toEqual(`${owner}/${name}`);

        // A lookup re-resolves to the same Repository.
        const plan = yield* stack.plan(program);
        expect(plan.resources.OnLookedUpRepository?.action).toEqual("noop");

        // Destroying the consumer removes the Label.
        yield* stack.destroy();
        const gone = yield* gh(Issues.getLabel({ owner, repo: name, name: "looked-up" })).pipe(
          Effect.as("found" as const),
          Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
        );
        expect(gone).toEqual("gone");
      }),
    { tags, timeout: 180_000 },
  );

  test.provider(
    "a lookup of a resource that doesn't exist fails the plan",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const repository = "alchemy-lookup-missing";
        const lookups = {
          Repository: GitHub.Repository.lookup({ owner, name: repository }),
          Label: GitHub.Label.lookup({ owner, repository, name: "missing" }),
          Milestone: GitHub.Milestone.lookup({ owner, repository, number: 1 }),
          Release: GitHub.Release.lookup({ owner, repository, tag: "v0.0.0-missing" }),
          Environment: GitHub.Environment.lookup({ owner, repository, name: "missing" }),
          Issue: GitHub.Issue.lookup({ owner, repository, number: 1 }),
          PullRequest: GitHub.PullRequest.lookup({ owner, repository, number: 1 }),
          Ruleset: GitHub.Ruleset.lookup({ owner, repository, rulesetId: 1 }),
        } as unknown as Record<string, Output.Output<unknown>>;

        const mismatches: Record<string, string> = {};
        for (const [id, lookup] of Object.entries(lookups)) {
          const exit = yield* Effect.exit(
            stack.plan(
              GitHub.Label(id, {
                owner,
                repository,
                name: id,
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
