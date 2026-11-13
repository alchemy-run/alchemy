import * as DigitalOcean from "@alchemy.run/digitalocean";
import { ignoreNotFound } from "@alchemy.run/digitalocean/internal/notFound";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { createProject, deleteProject, getProject } from "@distilled.cloud/digitalocean";
import { adopt, OwnedBySomeoneElse } from "alchemy/AdoptPolicy";
import * as Effect from "effect/Effect";
import { forgetAttributes, isGone, logLevel, testName } from "./support.ts";

const { test } = Test.make({ providers: DigitalOcean.providers() });

const LIVE_TAGS = ["provider:digitalocean", "provider:digitalocean:project", "live"];
const LIVE_TIMEOUT = 120_000;

const readProject = (projectId: string) =>
  getProject({ project_id: projectId }).pipe(Effect.map((response) => response.project));

test.provider(
  "project lifecycle: create, rename and change every field in place, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = testName(stack.stage, "project");
      const renamed = testName(stack.stage, "project-renamed");

      const created = yield* stack.deploy(DigitalOcean.Project("Shop", { name }));
      expect(created).toMatchObject({ name, purpose: "Web Application", isDefault: false });

      const updated = yield* stack.deploy(
        DigitalOcean.Project("Shop", {
          name: renamed,
          description: "the shop",
          purpose: "Service or API",
          environment: "Staging",
        }),
      );
      expect(updated.projectId).toEqual(created.projectId);
      expect(yield* readProject(created.projectId)).toMatchObject({
        name: renamed,
        description: "the shop",
        purpose: "Service or API",
        environment: "Staging",
      });

      yield* stack.destroy();

      expect(yield* isGone(readProject(created.projectId))).toBe(true);
    }).pipe(logLevel),
  { tags: LIVE_TAGS, timeout: LIVE_TIMEOUT },
);

test.provider(
  "a project created outside alchemy with the chosen name needs adopt(true)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = testName(stack.stage, "project-foreign");

      yield* Effect.acquireUseRelease(
        createProject({ name, purpose: "Web Application" }).pipe(
          Effect.map((response) => response.project),
        ),
        (foreign) =>
          Effect.gen(function* () {
            const declared = DigitalOcean.Project("Adopted", { name, environment: "Production" });
            const refused = yield* stack.deploy(declared).pipe(Effect.flip);
            expect(refused).toBeInstanceOf(OwnedBySomeoneElse);

            const adopted = yield* stack.deploy(declared.pipe(adopt(true)));
            expect(adopted.projectId).toEqual(foreign.id);
            expect((yield* readProject(foreign.id)).environment).toEqual("Production");

            yield* stack.destroy();

            expect(yield* isGone(readProject(foreign.id))).toBe(true);
          }),
        (foreign) => ignoreNotFound(deleteProject({ project_id: foreign.id })),
      );
    }).pipe(logLevel),
  { tags: LIVE_TAGS, timeout: LIVE_TIMEOUT },
);

test.provider(
  "a generated-name project whose attributes were lost is found by its name",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const declared = DigitalOcean.Project("Box", {});

      const created = yield* stack.deploy(declared);
      yield* forgetAttributes({ stack: stack.name, stage: stack.stage, fqn: "Box" });
      expect((yield* stack.deploy(declared)).projectId).toEqual(created.projectId);

      yield* stack.destroy();

      expect(yield* isGone(readProject(created.projectId))).toBe(true);
    }).pipe(logLevel),
  { tags: LIVE_TAGS, timeout: LIVE_TIMEOUT },
);
