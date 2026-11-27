import * as Coolify from "@alchemy.run/coolify";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as CoolifyApi from "@distilled.cloud/coolify";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { applicationGone, environmentGone, hasServer, testProject, testServer } from "./helpers.ts";

const { test } = Test.make({ providers: Coolify.providers() });

const tags = ["provider:coolify", "provider:coolify:application", "live"];

test.provider.skipIf(!hasServer)(
  "deploy, update and delete an image application",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const server = yield* testServer;
      const projectUuid = yield* testProject;

      const program = (image: string, env: Record<string, string | Redacted.Redacted<string>>) =>
        Effect.gen(function* () {
          const environment = yield* Coolify.Environment("Env", { project: projectUuid });
          const app = yield* Coolify.Application("Web", {
            project: projectUuid,
            environment: environment.environmentUuid,
            server,
            image,
            ports: [80],
            env,
            tags: ["alchemy-test"],
          });
          return { environment, app };
        });

      const created = yield* stack.deploy(
        program("nginx:1.27-alpine", { GREETING: "hello", SECRET: Redacted.make("s3cret") }),
      );
      expect(created.app.source).toEqual("image");
      expect(created.app.deploymentUuid).toEqual(expect.any(String));
      expect(created.app.status).toMatch(/^running/);
      expect(created.app.envKeys.sort()).toEqual(["GREETING", "SECRET"]);

      const fetched = yield* CoolifyApi.getApplication({ uuid: created.app.applicationUuid });
      expect(fetched.build_pack).toEqual("dockerimage");
      expect(fetched.docker_registry_image_tag).toEqual("1.27-alpine");
      expect(fetched.ports_exposes).toEqual("80");

      const deployment = yield* CoolifyApi.getDeployment({ uuid: created.app.deploymentUuid! });
      expect(deployment.status).toEqual("finished");

      const envs = yield* CoolifyApi.listEnvsByApplicationUuid({
        uuid: created.app.applicationUuid,
      });
      expect(
        envs
          .filter((e) => !e.is_preview)
          .map((e) => e.key)
          .sort(),
      ).toEqual(["GREETING", "SECRET"]);

      const tagNames = (yield* CoolifyApi.listTagsByApplicationUuid({
        uuid: created.app.applicationUuid,
      })).map((t) => t.name);
      expect(tagNames).toContain("alchemy-test");

      // Unchanged redeploy: no new deployment.
      const unchanged = yield* stack.deploy(
        program("nginx:1.27-alpine", { GREETING: "hello", SECRET: Redacted.make("s3cret") }),
      );
      expect(unchanged.app.deploymentUuid).toEqual(created.app.deploymentUuid);

      // New tag and a removed env var: updated in place and redeployed.
      const updated = yield* stack.deploy(program("nginx:1.28-alpine", { GREETING: "bye" }));
      expect(updated.app.applicationUuid).toEqual(created.app.applicationUuid);
      expect(updated.app.deploymentUuid).not.toEqual(created.app.deploymentUuid);
      expect(updated.app.envKeys).toEqual(["GREETING"]);

      const refetched = yield* CoolifyApi.getApplication({ uuid: created.app.applicationUuid });
      expect(refetched.docker_registry_image_tag).toEqual("1.28-alpine");
      const envsAfter = yield* CoolifyApi.listEnvsByApplicationUuid({
        uuid: created.app.applicationUuid,
      });
      expect(envsAfter.filter((e) => !e.is_preview).map((e) => e.key)).toEqual(["GREETING"]);

      yield* stack.destroy();
      expect(yield* applicationGone(created.app.applicationUuid)).toEqual("gone");
      expect(yield* environmentGone(projectUuid, created.environment.environmentUuid)).toEqual(
        "gone",
      );
    }),
  { tags, timeout: 600_000 },
);

test.provider.skipIf(!hasServer)(
  "build an inline Dockerfile",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const server = yield* testServer;
      const projectUuid = yield* testProject;

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const environment = yield* Coolify.Environment("Env", { project: projectUuid });
          const app = yield* Coolify.Application("Hello", {
            project: projectUuid,
            environment: environment.environmentUuid,
            server,
            dockerfile: {
              content: 'FROM busybox:1.36\nCMD ["httpd", "-f", "-p", "8080"]\n',
            },
            ports: [8080],
          });
          return { environment, app };
        }),
      );
      expect(deployed.app.source).toEqual("dockerfile");
      expect(deployed.app.status).toMatch(/^running/);

      const fetched = yield* CoolifyApi.getApplication({ uuid: deployed.app.applicationUuid });
      expect(fetched.build_pack).toEqual("dockerfile");
      expect(fetched.dockerfile).toContain("FROM busybox:1.36");

      yield* stack.destroy();
      expect(yield* applicationGone(deployed.app.applicationUuid)).toEqual("gone");
      expect(yield* environmentGone(projectUuid, deployed.environment.environmentUuid)).toEqual(
        "gone",
      );
    }),
  { tags, timeout: 600_000 },
);
