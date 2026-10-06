import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Docker from "@/Docker";
import { inMemoryState } from "@/State";
import * as Test from "@/Test/Alchemy";
import { findAvailablePort } from "./Runtime.ts";

// bcrypt htpasswd entry for alchemy:alchemy-test-password (`htpasswd -Bbn`).
const REGISTRY_HTPASSWD = "alchemy:$2y$05$7OoaHcebvt.2oLcNt7oRsOOALGNXUWi8IHUxTMRu9BWyXWDgM/3BK";

const { test } = Test.make({ providers: Docker.providers(), state: inMemoryState() });

describe(
  "Docker.Image",
  { tags: ["provider:docker", "provider:docker:image", "local"], concurrent: false },
  () => {
    test.provider("plans an update when the Docker context changes", (stack) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-docker-context-plan-" });
        yield* fs.writeFileString(path.join(root, "Dockerfile"), "FROM scratch\n");

        const base = Docker.Image("context-image", {
          tag: "latest",
          context: "default",
          build: { context: root },
        });
        const changed = Docker.Image("context-image", {
          tag: "latest",
          context: "remote-build",
          build: { context: root },
        });

        yield* stack.deploy(base);
        const plan = yield* stack.plan(changed);
        expect(plan.resources["context-image"]).toMatchObject({ action: "update" });
      }),
    );

    test.provider("builds a tiny Dockerfile with an auto-generated name", (stack) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-docker-image-" });
        yield* fs.writeFileString(
          path.join(root, "Dockerfile"),
          "FROM scratch\nLABEL alchemy.test=true\n",
        );
        // No explicit name: the engine auto-generates the physical name.
        const image = yield* stack.deploy(
          Docker.Image("tiny-image", { tag: "latest", build: { context: root } }),
        );
        expect(image.imageRef.endsWith(":latest")).toBe(true);
        expect(image.imageId.length).toBeGreaterThan(0);
      }),
    );

    test.provider("updates when the build context changes", (stack) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-docker-canary-" });
        yield* fs.writeFileString(path.join(root, "Dockerfile"), "FROM scratch\n");
        yield* fs.writeFileString(
          path.join(root, "Dockerfile"),
          "FROM scratch\nLABEL alchemy.test=1\n",
        );

        const makeStack = Docker.Image("tiny-image", { tag: "latest", build: { context: root } });

        yield* stack.deploy(makeStack);
        const plan1 = yield* stack.plan(makeStack);
        expect(plan1.resources["tiny-image"]).toMatchObject({ action: "noop" });
        yield* fs.writeFileString(
          path.join(root, "Dockerfile"),
          "FROM scratch\nLABEL alchemy.test=2\n",
        );
        const plan2 = yield* stack.plan(makeStack);
        expect(plan2.resources["tiny-image"]).toMatchObject({ action: "update" });
      }),
    );

    test.provider("builds with an explicit repository name and tag", (stack) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-docker-image-named-" });
        yield* fs.writeFileString(
          path.join(root, "Dockerfile"),
          "FROM scratch\nLABEL alchemy.test=named\n",
        );
        const image = yield* stack.deploy(
          Docker.Image("named-image", {
            name: "alchemy-test-named",
            tag: "v1",
            build: { context: root },
          }),
        );
        expect(image.name).toBe("alchemy-test-named");
        expect(image.imageRef).toBe("alchemy-test-named:v1");
        expect(image.tag).toBe("v1");
      }),
    );

    test.provider("rebuilds when the build context changes", (stack) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-docker-image-rebuild-" });
        const dockerfile = path.join(root, "Dockerfile");

        yield* fs.writeFileString(dockerfile, "FROM scratch\nLABEL gen=1\n");
        const first = yield* stack.deploy(
          Docker.Image("rebuilt-image", { tag: "latest", build: { context: root } }),
        );

        yield* fs.writeFileString(dockerfile, "FROM scratch\nLABEL gen=2\n");
        const second = yield* stack.deploy(
          Docker.Image("rebuilt-image", { tag: "latest", build: { context: root } }),
        );

        expect(second.imageRef).toBe(first.imageRef);
      }),
    );

    test.provider("builds FROM a private base image with the registry credentials", (stack) =>
      Effect.gen(function* () {
        const docker = yield* Docker.Docker;
        const client = yield* HttpClient.HttpClient;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const port = yield* findAvailablePort();
        const host = `localhost:${port}`;
        const registryName = "alchemy-test-auth-registry";
        const baseRef = `${host}/alchemy-base:v1`;
        const registry = {
          server: host,
          username: "alchemy",
          password: Redacted.make("alchemy-test-password"),
        };

        yield* Effect.addFinalizer(() =>
          Effect.all([
            docker.run(["rm", "-f", registryName]),
            docker.image.remove([baseRef, `${host}/alchemy-app:v1`], true),
          ]).pipe(Effect.ignore),
        );

        // An htpasswd-protected registry: anonymous pulls fail with 401, and
        // nothing on the host holds a `docker login` for this ephemeral port.
        yield* docker.run([
          "run",
          "-d",
          "--name",
          registryName,
          "-p",
          `${port}:5000`,
          "-e",
          `HTPASSWD=${REGISTRY_HTPASSWD}`,
          "-e",
          "REGISTRY_AUTH=htpasswd",
          "-e",
          "REGISTRY_AUTH_HTPASSWD_REALM=alchemy-test",
          "-e",
          "REGISTRY_AUTH_HTPASSWD_PATH=/auth/htpasswd",
          "--entrypoint",
          "/bin/sh",
          "registry:2",
          "-c",
          'mkdir -p /auth && echo "$HTPASSWD" > /auth/htpasswd && exec registry serve /etc/docker/registry/config.yml',
        ]);
        yield* client
          .get(`http://${host}/v2/`)
          .pipe(Effect.retry({ schedule: Schedule.exponential("250 millis"), times: 20 }));

        // Publish the private base image, then drop the local copy so the
        // build below has to pull it from the authenticated registry.
        yield* stack.deploy(
          Docker.RemoteImage("private-base", {
            name: "busybox",
            tag: "latest",
            targetName: `${host}/alchemy-base`,
            targetTag: "v1",
            registry,
          }),
        );
        yield* docker.image.remove(baseRef, true);

        const root = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-docker-private-base-" });
        yield* fs.writeFileString(
          path.join(root, "Dockerfile"),
          `FROM ${baseRef}\nLABEL alchemy.test=private-base\n`,
        );

        const image = yield* stack.deploy(
          Docker.Image("private-base-app", {
            name: `${host}/alchemy-app`,
            tag: "v1",
            registry,
            build: { context: root },
          }),
        );
        expect(image.imageRef).toBe(`${host}/alchemy-app:v1`);
        expect(image.repoDigest).toContain(`${host}/alchemy-app@sha256:`);
      }),
    );
  },
);
