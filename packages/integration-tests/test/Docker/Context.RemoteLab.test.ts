// Opt-in, real Docker Engine test for a machine reached over SSH or mTLS.
// Run with ALCHEMY_DOCKER_REMOTE_SPEC (a Docker --docker endpoint spec) and
// an isolated DOCKER_CONFIG. Keep credentials outside the spec: TLS uses
// filesystem paths, while SSH uses the runner's SSH agent or key files.
import * as Docker from "@alchemy.run/docker";
import { dockerContextTarget } from "@alchemy.run/docker/Docker";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { inMemoryState } from "alchemy/State";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

const dockerSpec = process.env.ALCHEMY_DOCKER_REMOTE_SPEC ?? "";

const transport = process.env.ALCHEMY_DOCKER_REMOTE_TRANSPORT ?? "unknown";
const swarmEnabled = process.env.ALCHEMY_DOCKER_REMOTE_SWARM === "1";
const rotateTls = process.env.ALCHEMY_DOCKER_REMOTE_ROTATE_TLS === "1";
// Stable per-stage names let reruns converge on and clean up the same objects.
const resourceName = (stage: string, suffix: string) =>
  `alchemy-3375-${stage}-${transport}-${suffix}`.toLowerCase().replace(/[^a-z0-9_.-]/g, "-");
const decodeServiceVersion = Schema.NonEmptyArray(
  Schema.Struct({ Version: Schema.Struct({ Index: Schema.Number }) }),
).pipe(Schema.fromJsonString, Schema.decodeEffect);
const { test } = Test.make({ providers: Docker.providers(), state: inMemoryState() });

test.provider.skipIf(!dockerSpec)(
  `real remote lifecycle, CI context loss and drift via ${transport}`,
  (stack) =>
    Effect.gen(function* () {
      const docker = yield* Docker.Docker;
      const name = resourceName(stack.stage, "lifecycle");
      const contextName = `${name}-ctx`;
      const containerName = `${name}-container`;
      const networkName = `${name}-network`;
      const volumeName = `${name}-volume`;
      const target = dockerContextTarget({ name: contextName, dockerSpec });
      expect(typeof target).toBe("object");

      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          yield* docker.container.remove(containerName, true, target).pipe(Effect.ignore);
          yield* docker.network.remove(networkName, target).pipe(Effect.ignore);
          yield* docker.volume.remove(volumeName, target).pipe(Effect.ignore);
          yield* docker.context.remove(contextName, true).pipe(Effect.ignore);
        }),
      );

      const program = (start: boolean) =>
        Effect.gen(function* () {
          const context = yield* Docker.Context("context", {
            name: contextName,
            description: `remote InstaBox ${transport} E2E`,
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
            start,
            networks: [{ name: network.name }],
            volumes: [{ hostPath: volume.name, containerPath: "/test-data" }],
          });
          return { context, network, volume, container };
        });

      yield* stack.destroy();
      const initial = yield* stack.deploy(program(false));
      expect(initial.context.dockerSpec).toBe(dockerSpec);
      expect((yield* docker.network.inspect(networkName, target)).Id).toBe(initial.network.id);
      expect((yield* docker.volume.inspect(volumeName, target)).Name).toBe(volumeName);
      expect((yield* docker.container.inspect(containerName, target)).Id).toBe(
        initial.container.id,
      );

      // Simulate a fresh CI runner: remove only the machine-local CLI context.
      yield* docker.context.remove(contextName, true);
      const stable = yield* stack.plan(program(false));
      for (const key of ["context", "network", "volume", "container"]) {
        expect(stable.resources[key]).toMatchObject({ action: "noop" });
      }

      // Changing runtime state must not replace an otherwise identical container.
      const startPlan = yield* stack.plan(program(true));
      expect(startPlan.resources.container).toMatchObject({ action: "update" });
      const started = yield* stack.deploy(program(true));
      expect(started.container.id).toBe(initial.container.id);
      expect((yield* docker.container.inspect(containerName, target)).State.Status).toBe("running");

      const startedPlan = yield* stack.plan(program(true));
      for (const key of ["context", "network", "volume", "container"]) {
        expect(startedPlan.resources[key]).toMatchObject({ action: "noop" });
      }

      yield* docker.container.remove(containerName, true, target);
      const containerDrift = yield* stack.plan(program(true));
      expect(containerDrift.resources.container).toMatchObject({ action: "update" });
      expect(containerDrift.resources.network).toMatchObject({ action: "noop" });
      expect(containerDrift.resources.volume).toMatchObject({ action: "noop" });
      const restoredContainer = yield* stack.deploy(program(true));
      expect(restoredContainer.container.id).not.toBe(initial.container.id);

      // Remove only lab-owned resources; repair must run on the remote Engine.
      yield* docker.container.remove(containerName, true, target);
      yield* docker.volume.remove(volumeName, target);
      const volumeDrift = yield* stack.plan(program(true));
      expect(volumeDrift.resources.volume).toMatchObject({ action: "update" });
      const restoredVolume = yield* stack.deploy(program(true));
      expect((yield* docker.volume.inspect(restoredVolume.volume.name, target)).Name).toBe(
        volumeName,
      );

      yield* docker.container.remove(containerName, true, target);
      yield* docker.network.remove(networkName, target);
      const networkDrift = yield* stack.plan(program(true));
      expect(networkDrift.resources.network).toMatchObject({ action: "update" });
      const restoredNetwork = yield* stack.deploy(program(true));
      expect(restoredNetwork.network.id).not.toBe(initial.network.id);
      expect((yield* docker.network.inspect(networkName, target)).Id).toBe(
        restoredNetwork.network.id,
      );

      yield* stack.destroy();
    }),
  { tags: ["provider:docker", "live"] },
);

test.provider.skipIf(!dockerSpec)(
  `real remote Dockerfile build without a local context via ${transport}`,
  (stack) =>
    Effect.gen(function* () {
      const docker = yield* Docker.Docker;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const name = resourceName(stack.stage, "image");
      const contextName = `${name}-ctx`;
      const imageRef = `${name}:e2e`;
      const target = dockerContextTarget({ name: contextName, dockerSpec });

      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          yield* docker.image.remove(imageRef, false, target).pipe(Effect.ignore);
          yield* docker.context.remove(contextName, true).pipe(Effect.ignore);
        }),
      );

      const root = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-3375-remote-build-" });
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
    }),
  { tags: ["provider:docker", "live"] },
);

// Swarm init/leave changes daemon-wide state. Opt in only on an isolated
// laboratory Engine; normal SSH and mTLS tests never initialize Swarm.
test.provider.skipIf(!dockerSpec || !swarmEnabled)(
  `real remote Swarm routes volumes and overlay networks through ${transport}`,
  (stack) =>
    Effect.gen(function* () {
      const docker = yield* Docker.Docker;
      const name = resourceName(stack.stage, "swarm");
      const contextName = `${name}-ctx`;
      const volumeName = `${name}-volume`;
      const networkName = `${name}-network`;
      const serviceName = `${name}-service`;
      const target = dockerContextTarget({ name: contextName, dockerSpec });
      expect(typeof target).toBe("object");

      // Model key rotation without changing the caller's original certificate:
      // deploy using a disposable old path and revoke only that path later.
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const realCert = /(?:^|,)cert=([^,]+)/.exec(dockerSpec)?.[1];
      if (rotateTls && !realCert) {
        return yield* Effect.die("TLS rotation test requires a client certificate path");
      }
      const certDir = rotateTls
        ? yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-3375-rotated-cert-" })
        : undefined;
      const temporaryOldCert = certDir ? path.join(certDir, "old-client.pem") : undefined;
      if (temporaryOldCert && realCert) yield* fs.copy(realCert, temporaryOldCert);
      const initialSpec =
        temporaryOldCert && realCert
          ? dockerSpec.replace(`cert=${realCert}`, `cert=${temporaryOldCert}`)
          : dockerSpec;

      // Refuse to adopt or dissolve a Swarm we did not initialize.
      const prior = yield* docker.swarm.info(target);
      expect(prior.LocalNodeState).not.toBe("active");
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          yield* docker.service.remove(serviceName, target).pipe(Effect.ignore);
          yield* docker.network.remove(networkName, target).pipe(Effect.ignore);
          yield* docker.volume.remove(volumeName, target).pipe(Effect.ignore);
          yield* docker.swarm.leave(true, target).pipe(Effect.ignore);
          yield* docker.context.remove(contextName, true).pipe(Effect.ignore);
        }),
      );

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

      if (rotateTls) {
        const newCert = path.join(certDir!, "new-client.pem");
        yield* fs.copy(realCert!, newCert);
        const nextSpec = initialSpec.replace(`cert=${temporaryOldCert}`, `cert=${newCert}`);

        const rotationPlan = yield* stack.plan(program(nextSpec));
        expect(rotationPlan.resources["swarm"]).not.toMatchObject({ action: "replace" });
        expect(rotationPlan.resources["swarm-service"]).not.toMatchObject({ action: "replace" });
        const rotated = yield* stack.deploy(program(nextSpec));
        expect(rotated.swarm.id).toBe(first.swarm.id);
        expect(rotated.service.id).toBe(first.service.id);
        expect(yield* serviceVersion(rotated.service.id)).toBe(initialVersion);
        const rotatedTarget = dockerContextTarget({ name: contextName, dockerSpec: nextSpec });
        expect(rotated.swarm.context).toEqual(rotatedTarget);
        expect(rotated.service.context).toEqual(rotatedTarget);
        // The old path no longer exists. Every provider must have persisted
        // the new endpoint before a fresh plan or destroy can run safely.
        yield* fs.remove(temporaryOldCert!);
        const stable = yield* stack.plan(program(nextSpec));
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
      expect((yield* docker.swarm.info(target)).LocalNodeState).not.toBe("active");
    }),
  { tags: ["provider:docker", "live"], timeout: 180_000 },
);
