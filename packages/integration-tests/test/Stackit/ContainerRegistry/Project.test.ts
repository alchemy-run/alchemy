import * as Docker from "@alchemy.run/docker";
import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as registry from "@distilled.cloud/stackit/registry";
import * as harbor from "@distilled.cloud/stackit/registry_harbor";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { logLevel, stackitEnvironment, stackitTags } from "../helpers.ts";
import {
  asHarborUser,
  harborIdentity,
  noHarborIdentity,
  observeProject,
  waitUntilProjectGone,
} from "./harbor.ts";

const { test } = Test.make({
  providers: Layer.mergeAll(Stackit.providers(), Docker.providers()),
});

// Container Registry is free of charge during its beta, so the lifecycle runs
// ungated.
const options = { tags: stackitTags("containerregistry", "project"), timeout: 300_000 } as const;

test.provider(
  "create and delete a project with a generated name",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      const project = () => Stackit.ContainerRegistry.Project("GeneratedProject", {});
      const created = yield* stack.deploy(project());

      expect(created.projectId).toEqual(projectId);
      expect(created.region).toEqual(region);
      expect(created.state).toEqual("Active");
      expect(created.name).toMatch(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/);
      expect(created.registryHost).not.toContain("/");
      expect(created.imagePrefix).toEqual(`${created.registryHost}/${created.name}`);
      expect(created.proxy).toBeUndefined();

      // Out of band: the project exists under that name.
      const fetched = yield* observeProject(projectId, region, created.artifactoryId);
      expect(fetched).toMatchObject({
        id: created.artifactoryId,
        name: created.name,
        url: created.url,
        state: "Active",
      });

      // Redeploying unchanged is a no-op.
      const plan = yield* stack.plan(project());
      expect(plan.resources.GeneratedProject).toMatchObject({ action: "noop" });

      yield* stack.destroy();
      expect(yield* waitUntilProjectGone(projectId, region, created.artifactoryId)).toEqual("gone");
    }).pipe(logLevel),
  options,
);

test.provider(
  "renaming a project replaces it, and the old one is deleted",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      const first = yield* stack.deploy(
        Stackit.ContainerRegistry.Project("NamedProject", { name: "alchemy-test-named-one" }),
      );
      expect(first.name).toEqual("alchemy-test-named-one");

      const second = yield* stack.deploy(
        Stackit.ContainerRegistry.Project("NamedProject", { name: "alchemy-test-named-two" }),
      );
      expect(second.name).toEqual("alchemy-test-named-two");
      expect(second.artifactoryId).not.toEqual(first.artifactoryId);
      expect(yield* waitUntilProjectGone(projectId, region, first.artifactoryId)).toEqual("gone");

      const live = yield* observeProject(projectId, region, second.artifactoryId);
      expect(live).toMatchObject({ name: "alchemy-test-named-two" });

      yield* stack.destroy();
      expect(yield* waitUntilProjectGone(projectId, region, second.artifactoryId)).toEqual("gone");
    }).pipe(logLevel),
  options,
);

test.provider(
  "a pull-through cache project updates its upstream in place and replaces on a new type",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      // The adapter comes from the API, not from a guess at its names.
      const { replication_adapters } = yield* registry.listReplicationAdapters({
        projectId,
        regionId: region,
      });
      const dockerHub = replication_adapters.find((adapter) =>
        adapter.registry_type.includes("docker-hub"),
      );
      const other = replication_adapters.find(
        (adapter) => adapter.registry_type !== dockerHub?.registry_type,
      );
      expect(dockerHub).toBeDefined();
      expect(other).toBeDefined();

      const created = yield* stack.deploy(
        Stackit.ContainerRegistry.Project("CacheProject", {
          proxy: {
            registryType: dockerHub!.registry_type,
            url: "https://hub.docker.com",
            description: "first",
          },
        }),
      );
      expect(created.proxy).toMatchObject({
        registryType: dockerHub!.registry_type,
        url: "https://hub.docker.com",
        description: "first",
      });

      const updated = yield* stack.deploy(
        Stackit.ContainerRegistry.Project("CacheProject", {
          proxy: {
            registryType: dockerHub!.registry_type,
            url: "https://hub.docker.com",
            description: "second",
          },
        }),
      );
      expect(updated.artifactoryId).toEqual(created.artifactoryId);
      const live = yield* observeProject(projectId, region, created.artifactoryId);
      expect(live).toMatchObject({ proxy: { description: "second" } });

      const replaced = yield* stack.deploy(
        Stackit.ContainerRegistry.Project("CacheProject", {
          proxy: { registryType: other!.registry_type, url: "https://registry.example.com" },
        }),
      );
      expect(replaced.artifactoryId).not.toEqual(created.artifactoryId);
      expect(yield* waitUntilProjectGone(projectId, region, created.artifactoryId)).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitUntilProjectGone(projectId, region, replaced.artifactoryId)).toEqual(
        "gone",
      );
    }).pipe(logLevel),
  options,
);

test.provider(
  "forceDestroy without an identity fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const error = yield* stack
        .deploy(Stackit.ContainerRegistry.Project("ForceProject", { forceDestroy: true }))
        .pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "Stackit.ContainerRegistry.ForceDestroyNeedsCredentials",
      });
      yield* stack.destroy();
    }).pipe(logLevel),
  options,
);

test.provider.skipIf(noHarborIdentity)(
  "forceDestroy deletes a project still holding an image",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      const { project, image } = yield* stack.deploy(
        Effect.gen(function* () {
          const project = yield* Stackit.ContainerRegistry.Project("HoldingProject", {
            forceDestroy: true,
            harborCredentials: harborIdentity,
          });
          const robot = yield* Stackit.ContainerRegistry.RobotAccount("HoldingRobot", {
            project: project.name,
            registryUrl: project.url,
            credentials: harborIdentity,
          });
          const image = yield* Docker.RemoteImage("HoldingImage", {
            name: "busybox",
            tag: "1.36",
            alwaysPull: false,
            targetName: Output.interpolate`${project.imagePrefix}/seed`,
            targetTag: "v1",
            registry: {
              server: project.registryHost,
              username: robot.robotName,
              password: robot.secret,
            },
          });
          return { project, image };
        }),
      );
      expect(image.imageRef).toContain(project.imagePrefix);

      // Out of band: the image reached the registry.
      const repositories = yield* harbor
        .listRepositories({ project_name: project.name })
        .pipe(asHarborUser(project.url));
      expect(repositories.map((repository) => repository.name)).toContain(`${project.name}/seed`);

      yield* stack.destroy();
      expect(yield* waitUntilProjectGone(projectId, region, project.artifactoryId)).toEqual("gone");
    }).pipe(logLevel),
  options,
);
