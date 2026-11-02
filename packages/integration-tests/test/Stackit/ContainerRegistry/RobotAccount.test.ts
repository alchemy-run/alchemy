import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as harbor from "@distilled.cloud/stackit/registry_harbor";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { logLevel, makeStackitTest, stackitTags } from "../helpers.ts";
import { asHarborUser, asRobot, harborIdentity, noHarborIdentity } from "./harbor.ts";

const { test } = makeStackitTest();

const options = {
  tags: stackitTags("containerregistry", "robotaccount"),
  timeout: 300_000,
} as const;

/** Out of band: the robot, or "gone" (typed NotFound). */
const observeRobot = (registryUrl: string, robotId: number) =>
  harbor.getRobot({ robot_id: robotId }).pipe(
    asHarborUser(registryUrl),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
  );

const accessOf = (robot: harbor.Robot) =>
  (robot.permissions ?? []).flatMap((permission) =>
    (permission.access ?? []).map((access) => `${access.resource}:${access.action}`),
  );

test.provider.skipIf(noHarborIdentity)(
  "create, update and delete a robot, whose login works and is scoped",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deploy = (robotProps: {
        description?: string;
        durationDays?: number;
        permissions?: Stackit.ContainerRegistry.RobotPermission[];
      }) =>
        stack.deploy(
          Effect.gen(function* () {
            const project = yield* Stackit.ContainerRegistry.Project("RobotProject", {});
            const robot = yield* Stackit.ContainerRegistry.RobotAccount("Robot", {
              project: project.name,
              registryUrl: project.url,
              credentials: harborIdentity,
              ...robotProps,
            });
            return { project, robot };
          }),
        );

      const { project, robot } = yield* deploy({
        description: "first",
        permissions: [{ resource: "repository", action: "list" }],
      });
      expect(robot.project).toEqual(project.name);
      expect(robot.robotName).toContain(`${project.name}+`);
      expect(robot.name).toEqual(robot.robotName.slice(robot.robotName.lastIndexOf("+") + 1));
      expect(Redacted.value(robot.secret).length).toBeGreaterThan(0);
      expect(robot.durationDays).toEqual(-1);
      expect(robot.disabled).toEqual(false);

      // Out of band: Harbor has the robot as described.
      const fetched = yield* observeRobot(project.url, robot.robotId);
      expect(fetched).toMatchObject({ description: "first", level: "project", disable: false });
      expect(accessOf(fetched as harbor.Robot)).toEqual(["repository:list"]);

      // Its login works for what it holds...
      const listed = yield* harbor
        .listRepositories({ project_name: project.name })
        .pipe(asRobot(robot));
      expect(listed).toEqual([]);
      // ...and nothing else: Harbor checks access before looking the repository up.
      const refused = yield* harbor
        .deleteRepository({ project_name: project.name, repository_name: "none" })
        .pipe(asRobot(robot), Effect.flip);
      expect(refused._tag).toEqual("Forbidden");

      // Update in place: same robot, same secret.
      const { robot: updated } = yield* deploy({
        description: "second",
        durationDays: 30,
        permissions: [
          { resource: "repository", action: "list" },
          { resource: "repository", action: "pull" },
        ],
      });
      expect(updated.robotId).toEqual(robot.robotId);
      expect(Redacted.value(updated.secret)).toEqual(Redacted.value(robot.secret));
      expect(updated.durationDays).toEqual(30);
      const refetched = yield* observeRobot(project.url, robot.robotId);
      expect(refetched).toMatchObject({ description: "second", duration: 30 });
      expect(accessOf(refetched as harbor.Robot).sort()).toEqual([
        "repository:list",
        "repository:pull",
      ]);

      // A redeploy with no change plans nothing for the robot.
      const replan = yield* stack.plan(
        Effect.gen(function* () {
          const planned = yield* Stackit.ContainerRegistry.Project("RobotProject", {});
          return yield* Stackit.ContainerRegistry.RobotAccount("Robot", {
            project: planned.name,
            registryUrl: planned.url,
            credentials: harborIdentity,
            description: "second",
            durationDays: 30,
            permissions: [
              { resource: "repository", action: "list" },
              { resource: "repository", action: "pull" },
            ],
          });
        }),
      );
      expect(replan.resources.Robot).toMatchObject({ action: "noop" });

      // Destroy deletes the robot first, then its project.
      const robotRegistry = project.url;
      yield* stack.destroy();
      expect(yield* observeRobot(robotRegistry, robot.robotId)).toEqual("gone");
    }).pipe(logLevel),
  options,
);

test.provider.skipIf(noHarborIdentity)(
  "renaming a robot replaces it and gives it a new secret",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deploy = (name: string) =>
        stack.deploy(
          Effect.gen(function* () {
            const project = yield* Stackit.ContainerRegistry.Project("RenamedRobotProject", {});
            return yield* Stackit.ContainerRegistry.RobotAccount("RenamedRobot", {
              project: project.name,
              registryUrl: project.url,
              credentials: harborIdentity,
              name,
            });
          }),
        );

      const first = yield* deploy("alchemy-test-first");
      expect(first.name).toEqual("alchemy-test-first");
      const second = yield* deploy("alchemy-test-second");
      expect(second.name).toEqual("alchemy-test-second");
      expect(second.robotId).not.toEqual(first.robotId);
      expect(Redacted.value(second.secret)).not.toEqual(Redacted.value(first.secret));
      expect(yield* observeRobot(first.registryUrl, first.robotId)).toEqual("gone");

      yield* stack.destroy();
      expect(yield* observeRobot(second.registryUrl, second.robotId)).toEqual("gone");
    }).pipe(logLevel),
  options,
);
