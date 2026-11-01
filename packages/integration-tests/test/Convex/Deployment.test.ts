import * as Convex from "@alchemy.run/convex";
import { DeploymentProtected } from "@alchemy.run/convex/Deployment";
import { previewIdentifier, previewReference } from "@alchemy.run/convex/internal/references";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as convex from "@distilled.cloud/convex/convex";
import * as deployments from "@distilled.cloud/convex/deployment";
import * as RemovalPolicy from "alchemy/RemovalPolicy";
import { isActionState, State } from "alchemy/State/State";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { onDeployment, projectsNamed, testName } from "./support.ts";

const { test } = Test.make({ providers: Convex.providers() });
const options = { timeout: 180_000 };

const app = (name: string, props: Omit<Convex.DeploymentProps, "project">) =>
  Effect.gen(function* () {
    const project = yield* Convex.Project("App", { name }).pipe(RemovalPolicy.destroy());
    const deployment = yield* Convex.Deployment("Deployment", { project, ...props });
    return { project, deployment };
  });

const missing = (name: string) =>
  convex.getDeployment({ deployment_name: name }).pipe(
    Effect.as(false),
    Effect.catchTag("DeploymentNotFound", () => Effect.succeed(true)),
  );

test.provider(
  "creates a preview by stage, destroy removes it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = yield* testName("deployment-preview");
      const { deployment } = yield* stack.deploy(app(name, { type: "preview" }));
      expect(deployment.type).toBe("preview");
      expect(deployment.reference).toBe(previewReference(stack.stage));
      expect(deployment.url).toContain("convex.cloud");
      expect(deployment.siteUrl).toContain("convex.site");

      yield* stack.destroy();
      expect(yield* missing(deployment.deploymentName)).toBe(true);
      expect(yield* projectsNamed(name)).toEqual([]);
    }),
  options,
);

test.provider(
  "reuses a preview with the same identifier",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = yield* testName("deployment-find");
      const first = yield* stack.deploy(
        Convex.Project("App", { name }).pipe(RemovalPolicy.destroy()),
      );
      const existing = yield* convex.createDeployment({
        project_id: first.projectId,
        type: "preview",
        reference: previewIdentifier(stack.stage),
      });

      const { deployment } = yield* stack.deploy(app(name, { type: "preview" }));
      expect(deployment.deploymentName).toBe(existing.name);

      const again = yield* stack.deploy(app(name, { type: "preview" }));
      expect(again.deployment.deploymentName).toBe(existing.name);
      expect(yield* missing(existing.name)).toBe(false);

      yield* stack.destroy();
      expect(yield* projectsNamed(name)).toEqual([]);
    }),
  options,
);

test.provider(
  "a vanished preview is recreated on the next deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = yield* testName("deployment-vanish");
      const first = yield* stack.deploy(app(name, { type: "preview" }));
      yield* convex.deleteDeployment({ deployment_name: first.deployment.deploymentName });

      const second = yield* stack.deploy(app(name, { type: "preview" }));
      expect(second.deployment.deploymentName).not.toBe(first.deployment.deploymentName);
      expect(second.deployment.reference).toBe(first.deployment.reference);
      expect(yield* missing(second.deployment.deploymentName)).toBe(false);

      yield* stack.destroy();
      expect(yield* projectsNamed(name)).toEqual([]);
    }),
  options,
);

test.provider(
  "prod refuses delete while protected",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = yield* testName("deployment-prod");
      const { deployment } = yield* stack.deploy(app(name, { type: "prod" }));
      expect(deployment.deletionProtection).toBe(true);
      expect(deployment.isDefault).toBe(true);

      const refused = yield* stack.destroy().pipe(Effect.result);
      expect(Result.isFailure(refused)).toBe(true);
      expect(yield* missing(deployment.deploymentName)).toBe(false);

      yield* stack.deploy(app(name, { type: "prod", deletionProtection: false }));
      yield* stack.destroy();
      expect(yield* missing(deployment.deploymentName)).toBe(true);
      expect(yield* projectsNamed(name)).toEqual([]);
    }),
  options,
);

test.provider(
  "a region change plans a replace",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = yield* testName("deployment-region");
      const first = yield* stack.deploy(
        app(name, { type: "preview", region: "aws-eu-west-1", deletionProtection: false }),
      );
      const second = yield* stack.deploy(
        app(name, { type: "preview", region: "aws-us-east-1", deletionProtection: false }),
      );
      expect(second.deployment.deploymentName).not.toBe(first.deployment.deploymentName);
      expect(second.deployment.region).toBe("aws-us-east-1");
      expect(yield* missing(first.deployment.deploymentName)).toBe(true);

      yield* stack.destroy();
      expect(yield* projectsNamed(name)).toEqual([]);
    }),
  options,
);

test.provider(
  "a protected deployment refuses a replace at plan time",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = yield* testName("deployment-protected");
      const first = yield* stack.deploy(
        app(name, { type: "preview", region: "aws-eu-west-1", deletionProtection: true }),
      );

      const refused = yield* stack
        .deploy(app(name, { type: "preview", region: "aws-us-east-1", deletionProtection: true }))
        .pipe(Effect.result);
      expect(Result.isFailure(refused)).toBe(true);
      if (Result.isFailure(refused)) expect(refused.failure).toBeInstanceOf(DeploymentProtected);
      expect(yield* missing(first.deployment.deploymentName)).toBe(false);

      yield* stack.deploy(
        app(name, { type: "preview", region: "aws-eu-west-1", deletionProtection: false }),
      );
      yield* stack.destroy();
      expect(yield* projectsNamed(name)).toEqual([]);
    }),
  options,
);

test.provider(
  "a vanished prod is an error, not a new empty database",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = yield* testName("deployment-vanished-prod");
      const { deployment } = yield* stack.deploy(app(name, { type: "prod" }));
      yield* convex.deleteDeployment({ deployment_name: deployment.deploymentName });

      const redeploy = yield* stack
        .deploy(app(name, { type: "prod", deletionProtection: false }))
        .pipe(Effect.result);
      expect(Result.isFailure(redeploy)).toBe(true);
      expect(yield* convex.listDeployments({ project_id: deployment.projectId })).toEqual([]);

      yield* convex.deleteProject({ project_id: deployment.projectId });
    }).pipe(Effect.ensuring(stack.destroy().pipe(Effect.ignore))),
  options,
);

test.provider(
  "transfers on a project change",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = yield* testName("deployment-move");
      const moved = (target: "A" | "B") =>
        Effect.gen(function* () {
          const a = yield* Convex.Project("A", { name: `${name}-a` }).pipe(RemovalPolicy.destroy());
          const b = yield* Convex.Project("B", { name: `${name}-b` }).pipe(RemovalPolicy.destroy());
          const deployment = yield* Convex.Deployment("Deployment", {
            project: target === "A" ? a : b,
            type: "dev",
          });
          return { a, b, deployment };
        });

      const before = yield* stack.deploy(moved("A"));
      yield* onDeployment(
        before.deployment.url,
        deployments.updateEnvironmentVariables({ changes: [{ name: "KEPT", value: "1" }] }),
      );

      const after = yield* stack.deploy(moved("B"));
      expect(after.deployment.deploymentName).toBe(before.deployment.deploymentName);
      expect(after.deployment.projectId).toBe(after.b.projectId);

      const live = yield* convex.getDeployment({
        deployment_name: after.deployment.deploymentName,
      });
      expect(live.projectId).toBe(after.b.projectId);
      const env = yield* onDeployment(
        after.deployment.url,
        deployments.listEnvironmentVariables({}),
      );
      expect(env.environmentVariables.KEPT).toBe("1");

      yield* stack.destroy();
      expect(yield* missing(after.deployment.deploymentName)).toBe(true);
    }),
  options,
);

test.provider(
  "pauses, and repeating either state is safe",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = yield* testName("deployment-pause");
      const paused = yield* stack.deploy(app(name, { type: "preview", paused: true }));
      expect(paused.deployment.paused).toBe(true);

      const resumed = yield* stack.deploy(app(name, { type: "preview", paused: false }));
      expect(resumed.deployment.paused).toBe(false);
      expect(resumed.deployment.deploymentName).toBe(paused.deployment.deploymentName);

      // Resuming a running deployment is an error on Convex's side.
      const again = yield* stack.deploy(
        app(name, { type: "preview", paused: false, isDefault: false }),
      );
      expect(again.deployment.paused).toBe(false);

      yield* stack.destroy();
      expect(yield* missing(paused.deployment.deploymentName)).toBe(true);
    }),
  options,
);

test.provider(
  "delete fails when the token can't see the deployment's team",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = yield* testName("deployment-team");
      const { deployment, project } = yield* stack.deploy(app(name, { type: "preview" }));
      expect(deployment.teamId).toBe(project.teamId);

      const setTeam = (teamId: number) =>
        Effect.gen(function* () {
          const state = yield* yield* State;
          const address = { stack: stack.name, stage: stack.stage, fqn: "Deployment" };
          const stored = yield* state.get(address);
          if (!stored || isActionState(stored) || !("attr" in stored) || !stored.attr) {
            return yield* Effect.die(new Error("Expected a deployment row with attributes"));
          }
          yield* state.set({
            ...address,
            value: { ...stored, attr: { ...stored.attr, teamId } },
          });
        }).pipe(Effect.provide(stack.state));

      yield* setTeam(1);
      const refused = yield* stack.destroy().pipe(Effect.result);
      expect(Result.isFailure(refused)).toBe(true);
      expect(yield* missing(deployment.deploymentName)).toBe(false);

      yield* setTeam(project.teamId);
      yield* stack.destroy();
      expect(yield* missing(deployment.deploymentName)).toBe(true);
    }),
  options,
);

test.provider("types a missing deployment", () =>
  Effect.gen(function* () {
    const error = yield* convex
      .getDeployment({ deployment_name: "no-such-deployment-0" })
      .pipe(Effect.flip);
    expect(error._tag).toBe("DeploymentNotFound");
  }),
);
