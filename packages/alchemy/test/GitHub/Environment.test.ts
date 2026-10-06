import { Octokit as OctokitClient } from "@octokit/rest";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";
import * as GitHub from "@/GitHub";
import { GitHubCredentials } from "@/GitHub/Credentials.ts";
import { Octokit } from "@/GitHub/Octokit.ts";
import * as Output from "@/Output";
import { destroy } from "@/RemovalPolicy";
import * as Test from "@/Test/Alchemy";

const { test } = Test.make({ providers: GitHub.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

// These tests create, mutate, and delete a real deployment environment, so
// they run against the dedicated test org (never a real one). Set
// GITHUB_TEST_OWNER="" to skip. The host repository is public because
// environments (and their protection rules) on private repositories are
// plan-gated.
const owner = process.env.GITHUB_TEST_OWNER ?? "alchemy-run-test";
const repo = process.env.GITHUB_TEST_ENVIRONMENT_REPOSITORY ?? "alchemy-effect-environment-test";

// Derive the repository name from the `fullName` output — referencing an
// output (rather than the `repo` constant) makes the engine order dependent
// resources after the repository exists.
const repoName = (repository: GitHub.Repository) =>
  Output.map(repository.fullName, (fullName) => fullName.split("/")[1]!);

const getEnvironment = (name: string) =>
  Effect.gen(function* () {
    const octokit = yield* Octokit;
    return yield* Effect.tryPromise({
      try: async () => {
        try {
          const { data } = await octokit.rest.repos.getEnvironment({
            owner,
            repo,
            environment_name: name,
          });
          return data;
        } catch (error: any) {
          if (error.status === 404) return undefined;
          throw error;
        }
      },
      catch: (e) => e as Error,
    });
  });

const listBranchPolicies = (name: string) =>
  Effect.gen(function* () {
    const octokit = yield* Octokit;
    return yield* Effect.tryPromise({
      try: async () => {
        const { data } = await octokit.rest.repos.listDeploymentBranchPolicies({
          owner,
          repo,
          environment_name: name,
          per_page: 100,
        });
        return (data.branch_policies ?? []).map((policy) => policy.name);
      },
      catch: (e) => e as Error,
    });
  });

test.provider.skipIf(!owner)(
  "create, update, and delete an environment with protection rules",
  (stack) =>
    Effect.gen(function* () {
      const name = "alchemy-test-production";

      // Clean up any leftovers from a previous run before deploying.
      yield* stack.destroy();

      // Create — environment with a wait timer and custom branch patterns.
      // `Repository` defaults to `retain`, so the host repo is created once
      // and reused across runs (reconcile is idempotent).
      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const repository = yield* GitHub.Repository("Repo", {
            owner,
            name: repo,
            description: "alchemy-effect environment test",
            visibility: "public",
            autoInit: true,
          });

          return yield* GitHub.Environment("Env", {
            owner,
            // Derive the repo name from a repository output so the engine
            // orders the environment after the repository exists.
            repository: repoName(repository),
            name,
            waitTimer: 5,
            preventSelfReview: true,
            deploymentBranchPolicy: {
              customBranchPolicies: ["main", "release/*"],
            },
          }).pipe(destroy());
        }),
      );

      expect(created.environmentId).toBeGreaterThan(0);
      expect(created.name).toEqual(name);
      expect(created.htmlUrl).toContain(repo);

      const fetched = yield* getEnvironment(name);
      expect(fetched?.id).toEqual(created.environmentId);
      expect(fetched?.deployment_branch_policy?.custom_branch_policies).toBe(true);
      const waitRule = fetched?.protection_rules?.find((rule) => rule.type === "wait_timer");
      expect(
        waitRule !== undefined && "wait_timer" in waitRule ? waitRule.wait_timer : undefined,
      ).toEqual(5);

      const patterns = yield* listBranchPolicies(name);
      expect(patterns.sort()).toEqual(["main", "release/*"]);

      // Update — drop the wait timer, converge the pattern list, same
      // logical ID → same environmentId (update in place, not replace).
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const repository = yield* GitHub.Repository("Repo", {
            owner,
            name: repo,
            description: "alchemy-effect environment test",
            visibility: "public",
          });

          return yield* GitHub.Environment("Env", {
            owner,
            repository: repoName(repository),
            name,
            deploymentBranchPolicy: {
              customBranchPolicies: ["main"],
            },
          }).pipe(destroy());
        }),
      );

      expect(updated.environmentId).toEqual(created.environmentId);
      const afterUpdate = yield* getEnvironment(name);
      const waitAfterUpdate = afterUpdate?.protection_rules?.find(
        (rule) => rule.type === "wait_timer",
      );
      expect(waitAfterUpdate).toBeUndefined();
      expect(yield* listBranchPolicies(name)).toEqual(["main"]);

      // Switch the policy mode to protected branches only.
      const switched = yield* stack.deploy(
        Effect.gen(function* () {
          const repository = yield* GitHub.Repository("Repo", {
            owner,
            name: repo,
            description: "alchemy-effect environment test",
            visibility: "public",
          });

          return yield* GitHub.Environment("Env", {
            owner,
            repository: repoName(repository),
            name,
            deploymentBranchPolicy: { protectedBranches: true },
          }).pipe(destroy());
        }),
      );

      expect(switched.environmentId).toEqual(created.environmentId);
      const afterSwitch = yield* getEnvironment(name);
      expect(afterSwitch?.deployment_branch_policy?.protected_branches).toBe(true);

      // Delete — the environment goes away; the retained repo stays.
      yield* stack.destroy();
      const afterDestroy = yield* getEnvironment(name);
      expect(afterDestroy).toBeUndefined();
    }).pipe(logLevel),
  {
    tags: ["provider:github", "provider:github:repository", "live"],
    timeout: 120_000,
  },
);

test.provider.skipIf(!owner)(
  "environment-scoped variable lifecycle",
  (stack) =>
    Effect.gen(function* () {
      const name = "alchemy-test-variables";

      yield* stack.destroy();

      const deployVariable = (value: string) =>
        stack.deploy(
          Effect.gen(function* () {
            const repository = yield* GitHub.Repository("Repo", {
              owner,
              name: repo,
              description: "alchemy-effect environment test",
              visibility: "public",
              autoInit: true,
            });

            const environment = yield* GitHub.Environment("Env", {
              owner,
              repository: repoName(repository),
              name,
            }).pipe(destroy());

            // Pass the Environment resource itself — the `environment` prop
            // accepts `string | Environment` and resolves the name.
            return yield* GitHub.Variable("Variable", {
              owner,
              repository: repoName(repository),
              environment,
              name: "ALCHEMY_ENV_TEST",
              value,
            }).pipe(destroy());
          }),
        );

      const readVariable = Effect.gen(function* () {
        const octokit = yield* Octokit;
        return yield* Effect.tryPromise({
          try: async () => {
            try {
              const { data } = await octokit.rest.actions.getEnvironmentVariable({
                owner,
                repo,
                environment_name: name,
                name: "ALCHEMY_ENV_TEST",
              });
              return data;
            } catch (error: any) {
              if (error.status === 404) return undefined;
              throw error;
            }
          },
          catch: (e) => e as Error,
        });
      });

      // Create — the variable lands in the environment, not the repo.
      yield* deployVariable("one");
      const fetched = yield* readVariable;
      expect(fetched?.value).toEqual("one");

      // Update — reconcile PATCHes the drifted value in place.
      yield* deployVariable("two");
      const afterUpdate = yield* readVariable;
      expect(afterUpdate?.value).toEqual("two");

      // Delete — destroying the stack removes the variable (and environment).
      yield* stack.destroy();
      const afterDestroy = yield* readVariable;
      expect(afterDestroy).toBeUndefined();
    }).pipe(logLevel),
  {
    tags: ["provider:github", "provider:github:repository", "provider:github:variable", "live"],
    timeout: 120_000,
  },
);

// Records every environment upsert body against a mocked GitHub API, so the
// exact request the provider sends can be asserted without a live org.
const mockedEnvironmentTest = (
  name: string,
  body: (
    stack: Test.ScratchStack,
    upserts: Array<Record<string, unknown>>,
  ) => Effect.Effect<void, any, any>,
) => {
  const upserts: Array<Record<string, unknown>> = [];
  const path = "/repos/alchemy-run-test/alchemy-environment-unit/environments/staging";
  const credentials = Effect.succeed({
    token: Redacted.make("test-token"),
    octokit: () =>
      new OctokitClient({
        auth: "test-token",
        request: {
          fetch: (url: string | URL | Request, options?: RequestInit) =>
            Effect.runPromise(
              Effect.sync(() => {
                const method = options?.method ?? "GET";
                if (new URL(String(url)).pathname !== path) {
                  throw new Error(`Unexpected mock request ${method} ${url}`);
                }
                if (method === "PUT") {
                  upserts.push(JSON.parse(String(options?.body)));
                  return Response.json({
                    id: 1,
                    node_id: "EN_1",
                    name: "staging",
                    html_url:
                      "https://github.com/alchemy-run-test/alchemy-environment-unit/deployments",
                    created_at: "2026-01-01T00:00:00Z",
                    updated_at: "2026-01-01T00:00:00Z",
                  });
                }
                if (method === "DELETE") return new Response(null, { status: 204 });
                throw new Error(`Unexpected mock method ${method}`);
              }),
            ),
        },
      }),
  });
  const { test } = Test.make({
    providers: Layer.succeed(GitHubCredentials, credentials).pipe(
      Layer.provideMerge(GitHub.providers({ baseUrl: "github.com" })),
    ),
  });
  test.provider(name, (stack) => body(stack, upserts), {
    tags: ["unit", "provider:github", "provider:github:environment", "local"],
  });
};

const unitEnvironment = (props: Partial<GitHub.EnvironmentProps>) =>
  GitHub.Environment("Env", {
    owner: "alchemy-run-test",
    repository: "alchemy-environment-unit",
    name: "staging",
    ...props,
  }).pipe(destroy());

mockedEnvironmentTest("unit: unmanaged protection fields are omitted", (stack, upserts) =>
  Effect.gen(function* () {
    yield* stack.destroy();
    yield* stack.deploy(unitEnvironment({ deploymentBranchPolicy: { protectedBranches: true } }));
    expect(upserts).toEqual([
      { deployment_branch_policy: { protected_branches: true, custom_branch_policies: false } },
    ]);
    yield* stack.destroy();
  }),
);

mockedEnvironmentTest("unit: a removed protection field resets to its default", (stack, upserts) =>
  Effect.gen(function* () {
    yield* stack.destroy();
    yield* stack.deploy(unitEnvironment({ waitTimer: 5, preventSelfReview: true }));
    yield* stack.deploy(unitEnvironment({ preventSelfReview: true }));
    yield* stack.deploy(unitEnvironment({}));
    expect(upserts).toEqual([
      { wait_timer: 5, prevent_self_review: true, deployment_branch_policy: null },
      { wait_timer: 0, prevent_self_review: true, deployment_branch_policy: null },
      { prevent_self_review: false, deployment_branch_policy: null },
    ]);
    yield* stack.destroy();
  }),
);
