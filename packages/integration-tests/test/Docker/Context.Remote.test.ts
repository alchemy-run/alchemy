// Opt-in integration tests against an isolated Docker Engine reached over SSH
// or mTLS. Supply ALCHEMY_DOCKER_REMOTE_SPEC and an isolated DOCKER_CONFIG.
// Docker uses certificate paths for TLS; SSH uses the runner's agent/key files.
// Only for a disposable Engine: ALCHEMY_DOCKER_REMOTE_SWARM=1 permits Swarm
// init/teardown; ALCHEMY_DOCKER_REMOTE_ROTATE_TLS=1 selects the mTLS rotation
// case instead of the ordinary Swarm case. Neither flag is used by default.
import * as Docker from "@alchemy.run/docker";
import { dockerContextTarget, dockerEndpointFromSpec } from "@alchemy.run/docker/Docker";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { inMemoryState } from "alchemy/State";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

// Env reads are limited to registration-time skipIf gates (per AGENTS.md).
// Runtime configuration is provided by effect/Config within the test Effect.
const remoteEnabled = !!process.env.ALCHEMY_DOCKER_REMOTE_SPEC;
const swarmEnabled = process.env.ALCHEMY_DOCKER_REMOTE_SWARM === "1";
const rotateTlsEnabled = process.env.ALCHEMY_DOCKER_REMOTE_ROTATE_TLS === "1";
// Stage-derived names remain deterministic across retries and test runs.
const resourceName = (stage: string, suffix: string) =>
  `alchemy-test-context-remote-${stage}-${suffix}`.toLowerCase().replace(/[^a-z0-9_.-]/g, "-");

const remoteSpec = Effect.gen(function* () {
  // Avoid changing the developer's machine-local Docker context configuration.
  yield* Config.String("DOCKER_CONFIG");
  return yield* Config.String("ALCHEMY_DOCKER_REMOTE_SPEC");
});
const decodeServiceVersion = Schema.NonEmptyArray(
  Schema.Struct({ Version: Schema.Struct({ Index: Schema.Number }) }),
).pipe(Schema.fromJsonString, Schema.decodeEffect);
const { test } = Test.make({ providers: Docker.providers(), state: inMemoryState() });

test.provider.skipIf(!remoteEnabled)(
  "plans no changes and repairs container drift without a machine-local context",
  (stack) =>
    Effect.gen(function* () {
      const docker = yield* Docker.Docker;
      const dockerSpec = yield* remoteSpec;
      const name = resourceName(stack.stage, "lifecycle");
      const contextName = `${name}-ctx`;
      const containerName = `${name}-container`;
      const networkName = `${name}-network`;
      const volumeName = `${name}-volume`;
      const target = dockerContextTarget({ name: contextName, dockerSpec });
      expect(typeof target).toBe("object");

      // test.provider already guarantees scratch-stack cleanup on failure and interruption.
      const program = Effect.gen(function* () {
        const context = yield* Docker.Context("context", {
          name: contextName,
          description: "remote Docker Engine E2E",
          docker: dockerSpec,
        });
        const network = yield* Docker.Network("network", {
          name: networkName,
          context,
        });
        const volume = yield* Docker.Volume("volume", {
          name: volumeName,
          context,
        });
        const container = yield* Docker.Container("container", {
          name: containerName,
          context,
          image: "alpine:3.22",
          command: ["sleep", "600"],
          start: false,
          networks: [{ name: network.name }],
          volumes: [{ hostPath: volume.name, containerPath: "/test-data" }],
        });
        return { context, network, volume, container };
      });

      yield* stack.destroy();
      const initial = yield* stack.deploy(program);
      expect(initial.context.dockerSpec).toBe(dockerSpec);
      expect((yield* docker.network.inspect(networkName, target)).Id).toBe(initial.network.id);
      expect((yield* docker.volume.inspect(volumeName, target)).Name).toBe(volumeName);
      expect((yield* docker.container.inspect(containerName, target)).Id).toBe(
        initial.container.id,
      );

      // Simulate a fresh CI runner: remove only the machine-local CLI context.
      yield* docker.context.remove(contextName, true);
      const stable = yield* stack.plan(program);
      for (const key of ["context", "network", "volume", "container"]) {
        expect(stable.resources[key]).toMatchObject({ action: "noop" });
      }

      yield* docker.container.remove(containerName, true, target);
      const containerDrift = yield* stack.plan(program);
      expect(containerDrift.resources.container).toMatchObject({ action: "update" });
      expect(containerDrift.resources.network).toMatchObject({ action: "noop" });
      expect(containerDrift.resources.volume).toMatchObject({ action: "noop" });
      const restoredContainer = yield* stack.deploy(program);
      expect(restoredContainer.container.id).not.toBe(initial.container.id);

      yield* stack.destroy();
      const gone = yield* docker.container.inspect(containerName, target).pipe(Effect.flip);
      expect(gone.reason._tag).toBe("NotFound");
    }),
  { tags: ["provider:docker", "provider:docker:context", "live"], timeout: 120_000 },
);

test.provider.skipIf(!remoteEnabled)(
  "builds a Dockerfile through a remote Engine without a local context",
  (stack) =>
    Effect.gen(function* () {
      const docker = yield* Docker.Docker;
      const dockerSpec = yield* remoteSpec;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const name = resourceName(stack.stage, "image");
      const contextName = `${name}-ctx`;
      const imageRef = `${name}:e2e`;
      const target = dockerContextTarget({ name: contextName, dockerSpec });

      const root = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-test-remote-build-" });
      yield* fs.writeFileString(
        path.join(root, "Dockerfile"),
        "FROM scratch\nLABEL alchemy.remote-e2e=true\n",
      );

      const program = Effect.gen(function* () {
        const context = yield* Docker.Context("image-context", {
          name: contextName,
          docker: dockerSpec,
        });
        const image = yield* Docker.Image("image", {
          name,
          tag: "e2e",
          context,
          build: { context: root },
        });
        return { context, image };
      });

      yield* stack.destroy();
      const first = yield* stack.deploy(program);
      expect(first.image.imageId.length).toBeGreaterThan(0);
      const remote = yield* docker.image.inspect(imageRef, target);
      expect(remote.Id).toBe(first.image.imageId);
      yield* docker.context.remove(contextName, true);
      const noop = yield* stack.plan(program);
      expect(noop.resources["image-context"]).toMatchObject({ action: "noop" });
      expect(noop.resources.image).toMatchObject({ action: "noop" });
      yield* stack.destroy();
      const gone = yield* docker.image.inspect(imageRef, target).pipe(Effect.flip);
      expect(gone.reason._tag).toBe("NotFound");
    }),
  { tags: ["provider:docker", "provider:docker:context", "live"], timeout: 120_000 },
);

// Never use a shared or production Engine for Swarm tests: initialization and
// teardown mutate daemon-wide state. This requires an explicit opt-in.
const swarmLifecycle = (rotateTls: boolean) => (stack: Test.ScratchStack) =>
  Effect.gen(function* () {
    const docker = yield* Docker.Docker;
    const dockerSpec = yield* remoteSpec;
    const name = resourceName(stack.stage, "swarm");
    const contextName = `${name}-ctx`;
    const volumeName = `${name}-volume`;
    const networkName = `${name}-network`;
    const serviceName = `${name}-service`;
    const target = dockerContextTarget({ name: contextName, dockerSpec });
    expect(typeof target).toBe("object");

    // A remote test must never adopt or dissolve an existing Swarm. This
    // also rejects pending, locked and error states before changing anything.
    const prior = yield* docker.swarm.info(target);
    expect(prior.LocalNodeState).toBe("inactive");

    // Model TLS rotation without mutating the original certificate. A
    // scoped fixture supplies disposable old/new paths, then revokes only
    // the old path after the provider has updated persisted state.
    const rotation = rotateTls
      ? yield* Effect.gen(function* () {
          const realCert = dockerEndpointFromSpec(dockerSpec)?.cert;
          if (!realCert) {
            return yield* Effect.fail(new Error("TLS rotation requires a client certificate path"));
          }
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const directory = yield* fs.makeTempDirectoryScoped({
            prefix: "alchemy-test-remote-cert-",
          });
          const oldCert = path.join(directory, "old-client.pem");
          const newCert = path.join(directory, "new-client.pem");
          yield* fs.copy(realCert, oldCert);
          yield* fs.copy(realCert, newCert);
          return {
            initialSpec: dockerSpec.replace(`cert=${realCert}`, `cert=${oldCert}`),
            nextSpec: dockerSpec.replace(`cert=${realCert}`, `cert=${newCert}`),
            oldCert,
          };
        })
      : undefined;
    const initialSpec = rotation?.initialSpec ?? dockerSpec;

    const program = (spec: string) =>
      Effect.gen(function* () {
        const context = yield* Docker.Context("swarm-context", {
          name: contextName,
          docker: spec,
        });
        const swarm = yield* Docker.Swarm("swarm", { context });
        const volume = yield* Docker.Volume("swarm-volume", {
          name: volumeName,
          context: swarm,
        });
        const network = yield* Docker.Network("swarm-network", {
          name: networkName,
          driver: "overlay",
          context: swarm,
        });
        // No tasks are started: verify service endpoint routing and stored
        // identity without requiring a registry pull or consuming CPU.
        const service = yield* Docker.Service("swarm-service", {
          name: serviceName,
          context: swarm,
          image: "alpine:3.22",
          networks: [network.name],
          replicas: 0,
        });
        return { context, swarm, volume, network, service };
      });

    yield* stack.destroy();
    const first = yield* stack.deploy(program(initialSpec));
    expect((yield* docker.swarm.info(target)).LocalNodeState).toBe("active");
    expect((yield* docker.volume.inspect(volumeName, target)).Name).toBe(first.volume.name);
    expect((yield* docker.network.inspect(networkName, target)).Id).toBe(first.network.id);
    const serviceVersion = (id: string) =>
      docker.service.inspect(id, target).pipe(
        Effect.flatMap(({ stdout }) => decodeServiceVersion(stdout)),
        Effect.map(([service]) => service.Version.Index),
      );
    const initialVersion = yield* serviceVersion(first.service.id);
    expect(Number.isSafeInteger(initialVersion)).toBe(true);

    yield* docker.context.remove(contextName, true);
    const unchanged = yield* stack.plan(program(initialSpec));
    for (const key of [
      "swarm-context",
      "swarm",
      "swarm-volume",
      "swarm-network",
      "swarm-service",
    ]) {
      expect(unchanged.resources[key]).toMatchObject({ action: "noop" });
    }

    yield* docker.volume.remove(volumeName, target);
    const drift = yield* stack.plan(program(initialSpec));
    expect(drift.resources["swarm-volume"]).toMatchObject({ action: "update" });
    const repaired = yield* stack.deploy(program(initialSpec));
    expect((yield* docker.volume.inspect(volumeName, target)).Name).toBe(repaired.volume.name);

    if (rotation) {
      const rotationPlan = yield* stack.plan(program(rotation.nextSpec));
      expect(rotationPlan.resources["swarm"]).not.toMatchObject({ action: "replace" });
      expect(rotationPlan.resources["swarm-service"]).not.toMatchObject({ action: "replace" });
      const rotated = yield* stack.deploy(program(rotation.nextSpec));
      expect(rotated.swarm.id).toBe(first.swarm.id);
      expect(rotated.service.id).toBe(first.service.id);
      expect(yield* serviceVersion(rotated.service.id)).toBe(initialVersion);
      const rotatedTarget = dockerContextTarget({
        name: contextName,
        dockerSpec: rotation.nextSpec,
      });
      expect(rotated.swarm.context).toEqual(rotatedTarget);
      expect(rotated.service.context).toEqual(rotatedTarget);
      // The old path no longer exists. Every provider must have persisted
      // the new endpoint before a fresh plan or destroy can run safely.
      const fs = yield* FileSystem.FileSystem;
      yield* fs.remove(rotation.oldCert);
      const stable = yield* stack.plan(program(rotation.nextSpec));
      for (const key of [
        "swarm-context",
        "swarm",
        "swarm-volume",
        "swarm-network",
        "swarm-service",
      ]) {
        expect(stable.resources[key]).toMatchObject({ action: "noop" });
      }
    }

    yield* stack.destroy();
    expect((yield* docker.swarm.info(target)).LocalNodeState).toBe("inactive");
  });

test.provider.skipIf(!remoteEnabled || !swarmEnabled || rotateTlsEnabled)(
  "reconciles remote Swarm, overlay network and volume without a local context",
  swarmLifecycle(false),
  {
    tags: ["provider:docker", "provider:docker:swarm", "live"],
    timeout: 180_000,
    exclusive: "docker:remote-swarm",
  },
);

test.provider.skipIf(!remoteEnabled || !swarmEnabled || !rotateTlsEnabled)(
  "refreshes mTLS credentials without replacing or rolling out remote Swarm services",
  swarmLifecycle(true),
  {
    tags: ["provider:docker", "provider:docker:swarm", "live"],
    timeout: 180_000,
    exclusive: "docker:remote-swarm",
  },
);
