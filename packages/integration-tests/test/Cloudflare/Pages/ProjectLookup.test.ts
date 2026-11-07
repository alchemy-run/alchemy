import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as pages from "@distilled.cloud/cloudflare/pages";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import { expectDeployFails, missingName } from "../../lookup.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

const tags = ["provider:cloudflare", "provider:cloudflare:pages", "live"];

// The target belongs to another stack, as a lookup's target always should.
const TargetStack = Alchemy.Stack(
  "PagesProjectLookupTarget",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const project = yield* Cloudflare.Pages.Project("lookup-target", {});
    return { name: project.name.as<string>(), projectId: project.projectId.as<string>() };
  }),
);

const target = beforeAll(deploy(TargetStack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(TargetStack));

test.provider(
  "a looked-up project takes a deployment, and survives destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { accountId } = yield* yield* CloudflareEnvironment;
      const { name, projectId } = yield* target;

      const program = Effect.gen(function* () {
        const project = Cloudflare.Pages.Project.lookup({ name });
        const deployment = yield* Cloudflare.Pages.Deployment("project-lookup-deployment", {
          projectName: project.name,
          branch: "lookup",
        });
        return {
          projectId: project.projectId,
          projectName: deployment.projectName,
          deploymentId: deployment.deploymentId,
        };
      });
      const out = yield* stack.deploy(program);
      expect(out.projectId).toBe(projectId);
      expect(out.projectName).toBe(name);

      const live = yield* pages.getProjectDeployment({
        accountId,
        projectName: name,
        deploymentId: out.deploymentId,
      });
      expect(live.environment).toBe("preview");

      // A lookup re-resolves to the same project, so nothing changes.
      const plan = yield* stack.plan(program);
      expect(plan.resources["project-lookup-deployment"].action).toBe("noop");

      // Destroying the stack that looked it up leaves the project alone.
      yield* stack.destroy();
      const survivor = yield* pages.getProject({ accountId, projectName: name });
      expect(survivor.id).toBe(projectId);
    }),
  { tags, timeout: 240_000 },
);

test.provider(
  "a lookup of a missing project fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectDeployFails(
        stack.deploy(
          Cloudflare.Pages.Deployment("project-lookup-missing", {
            projectName: Cloudflare.Pages.Project.lookup({ name }).name,
          }),
        ),
        ["LookupNotFoundError", name],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a lookup of a project this stack manages fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const managed = () => Cloudflare.Pages.Project("lookup-managed", {});
      const { name } = yield* stack.deploy(managed());
      yield* expectDeployFails(
        stack.deploy(
          Effect.gen(function* () {
            yield* managed();
            yield* Cloudflare.Pages.Deployment("project-lookup-managed-deployment", {
              projectName: Cloudflare.Pages.Project.lookup({ name }).name,
              branch: "lookup",
            });
          }),
        ),
        ["LookupOfManagedResourceError", "lookup-managed"],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);
