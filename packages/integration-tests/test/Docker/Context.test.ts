import * as Docker from "@alchemy.run/docker";
import {
  dockerContextTarget,
  dockerTargetArgs,
  sameDockerContextTarget,
} from "@alchemy.run/docker/Docker";
import { describe, expect, it } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Output from "alchemy/Output";
import * as Provider from "alchemy/Provider";
import { inMemoryState } from "alchemy/State";
import * as Effect from "effect/Effect";
import { expectFound } from "./lookup.ts";

const { test } = Test.make({ providers: Docker.providers(), state: inMemoryState() });

test.provider(
  "diff replaces a context when name changes",
  () =>
    Effect.gen(function* () {
      const contextProvider = yield* Provider.findProvider(Docker.Context);
      const contextDiff = yield* contextProvider.diff!({
        id: "build-context",
        fqn: "build-context",
        instanceId: "instance",
        olds: { name: "old-context", description: "old" },
        news: { name: "new-context", description: "old" },
        oldBindings: [],
        newBindings: [],
        output: { id: "old-context", name: "old-context", description: "old", docker: undefined },
      });
      expect(contextDiff).toEqual({ action: "replace", deleteFirst: true });
    }),
  { tags: ["provider:docker", "provider:docker:context", "local"] },
);

test.provider(
  "diff updates a context when description changes",
  () =>
    Effect.gen(function* () {
      const contextProvider = yield* Provider.findProvider(Docker.Context);
      const contextDiff = yield* contextProvider.diff!({
        id: "build-context",
        fqn: "build-context",
        instanceId: "instance",
        olds: {
          name: "build-context",
          description: "old description",
          docker: "host=unix:///var/run/docker.sock",
        },
        news: {
          name: "build-context",
          description: "new description",
          docker: "host=unix:///var/run/docker.sock",
        },
        oldBindings: [],
        newBindings: [],
        output: {
          id: "build-context",
          name: "build-context",
          description: "old description",
          docker: "host=unix:///var/run/docker.sock",
        },
      });
      expect(contextDiff).toEqual({ action: "update" });
    }),
  { tags: ["provider:docker", "provider:docker:context", "local"] },
);

test.provider(
  "diff replaces a context when docker endpoint is removed",
  () =>
    Effect.gen(function* () {
      const contextProvider = yield* Provider.findProvider(Docker.Context);
      const contextDiff = yield* contextProvider.diff!({
        id: "build-context",
        fqn: "build-context",
        instanceId: "instance",
        olds: {
          name: "build-context",
          description: "dev context",
          docker: "host=ssh://user@example.com",
        },
        news: { name: "build-context", description: "dev context" },
        oldBindings: [],
        newBindings: [],
        output: {
          id: "build-context",
          name: "build-context",
          description: "dev context",
          docker: "host=ssh://user@example.com",
        },
      });
      expect(contextDiff).toEqual({ action: "replace", deleteFirst: true });
    }),
  { tags: ["provider:docker", "provider:docker:context", "local"] },
);

test.provider(
  "retains legacy managed SSH state on a new runner without Docker context entries",
  () =>
    Effect.gen(function* () {
      const docker = yield* Docker.Docker;
      const name = "alchemy-3375-legacy-absent-context";
      const prior = { name, docker: "host=ssh://deploy@example.com" };
      const previousAttributes = {
        id: name,
        name,
        description: "",
        docker: { Host: "ssh://deploy@example.com", SkipTLSVerify: false },
      };
      const provider = yield* Provider.findProvider(Docker.Context);
      const missing = yield* docker.context.inspect(name).pipe(Effect.flip);
      expect(missing.reason._tag).toBe("NotFound");
      const diff = yield* provider.diff!({
        id: "legacy-context",
        fqn: "legacy-context",
        instanceId: "instance",
        olds: prior,
        news: prior,
        oldBindings: [],
        newBindings: [],
        output: previousAttributes,
      });
      expect(diff).toEqual({ action: "noop" });
      expect(dockerContextTarget(previousAttributes)).toEqual({ host: "ssh://deploy@example.com" });
    }),
  { tags: ["provider:docker", "provider:docker:context", "local"] },
);

describe(
  "Docker.Context",
  { tags: ["provider:docker", "provider:docker:context", "local"], concurrent: false },
  () => {
    it("resolves managed SSH endpoints without a machine-local context", () => {
      const remote = { name: "ci-context", dockerSpec: "host=ssh://deploy@example.com" };
      expect(dockerContextTarget(remote)).toEqual({ host: "ssh://deploy@example.com" });
      expect(dockerTargetArgs(dockerContextTarget(remote))).toEqual([
        "--host",
        "ssh://deploy@example.com",
      ]);
      expect(sameDockerContextTarget(remote, { ...remote, name: "another-local-alias" })).toBe(
        true,
      );
      expect(sameDockerContextTarget(remote, { name: "ci-context" })).toBe(false);
      expect(dockerContextTarget({ name: "external-context" })).toBe("external-context");
    });

    test.provider("preserves named context selection for external lookups", (stack) =>
      Effect.gen(function* () {
        const external = Docker.Context.lookup({ name: "default" });
        const plan = yield* stack.plan(
          Docker.Volume("context-selection-probe", {
            labels: {
              target: Output.all(external.name, external.docker, external.lookupOnly).pipe(
                Output.map(([name, docker, lookupOnly]) =>
                  JSON.stringify(dockerContextTarget({ name, docker, lookupOnly })),
                ),
              ),
            },
          }),
        );
        expect(plan.resources["context-selection-probe"]).toMatchObject({
          props: { labels: { target: '"default"' } },
        });
      }),
    );

    it("forwards TLS certificate paths without embedding material in state", () => {
      const remote = {
        name: "ci-tls",
        dockerSpec:
          "host=tcp://docker.example.com:2376,ca=/certs/ca.pem,cert=/certs/client.pem,key=/certs/client-key.pem",
      };
      expect(dockerTargetArgs(dockerContextTarget(remote))).toEqual([
        "--host",
        "tcp://docker.example.com:2376",
        "--tlscacert",
        "/certs/ca.pem",
        "--tlscert",
        "/certs/client.pem",
        "--tlskey",
        "/certs/client-key.pem",
        "--tlsverify",
      ]);
    });

    it("retains TLS when the managed endpoint skips certificate verification", () => {
      const remote = {
        name: "ci-tls-unverified",
        dockerSpec: "host=tcp://docker.example.com:2376,skip-tls-verify=true",
      };
      expect(dockerTargetArgs(dockerContextTarget(remote))).toEqual([
        "--host",
        "tcp://docker.example.com:2376",
        "--tls",
      ]);
    });

    it("understands Docker CLI boolean spellings for skipped TLS verification", () => {
      for (const enabled of ["1", "t", "TRUE"]) {
        const target = dockerContextTarget({
          name: "ci-tls-unverified",
          dockerSpec: `host=tcp://docker.example.com:2376,skip-tls-verify=${enabled}`,
        });
        expect(dockerTargetArgs(target)).toEqual([
          "--host",
          "tcp://docker.example.com:2376",
          "--tls",
        ]);
      }
    });

    it("does not downgrade an invalid TLS mode to plaintext TCP", () => {
      const remote = {
        name: "ci-unrecognized-tls",
        dockerSpec: "host=tcp://docker.example.com:2376,skip-tls-verify=invalid",
      };
      expect(dockerContextTarget(remote)).toBe(remote.name);
    });

    test.provider("does not treat a disconnected Docker engine as missing infrastructure", () =>
      Effect.gen(function* () {
        const docker = yield* Docker.Docker;
        const target = {
          host: "unix:///tmp/alchemy-3375-nonexistent-docker.sock",
        };
        const failure = yield* docker.network.inspect("bridge", target).pipe(Effect.flip);
        expect(failure.reason._tag).not.toBe("NotFound");
      }),
    );

    // Every prop is optional: `Docker.Context("ctx")` must plan, deploy,
    // redeploy in place, and destroy without a props object.
    test.provider("deploys a context declared without props", (stack) =>
      Effect.gen(function* () {
        const docker = yield* Docker.Docker;
        yield* stack.destroy();
        const first = yield* stack.deploy(Docker.Context("bare-context"));
        yield* expectFound(Docker.Context.lookup({ name: first.name }), first);
        const second = yield* stack.deploy(Docker.Context("bare-context"));
        expect(second.id).toBe(first.id);
        yield* stack.destroy();
        const gone = yield* docker.context.inspect(first.name).pipe(Effect.flip);
        expect(gone.reason._tag).toBe("NotFound");
      }),
    );

    test.provider("creates a context with description and endpoint", (stack) =>
      Effect.gen(function* () {
        const docker = yield* Docker.Docker;
        const contextName = "alchemy-test-context-create";

        yield* Effect.addFinalizer(() =>
          docker.context.remove(contextName, true).pipe(Effect.ignore),
        );

        const context = yield* stack.deploy(
          Docker.Context("created-context", {
            name: contextName,
            description: "created by alchemy tests",
            docker: "host=unix:///var/run/docker.sock",
          }),
        );

        expect(context.name).toBe(contextName);
        expect(context.id).toBe(contextName);
        expect(context.description).toBe("created by alchemy tests");
        expect(extractDockerHost(context.docker)).toBe("unix:///var/run/docker.sock");
      }),
    );

    test.provider("updates an existing context without replacing it", (stack) =>
      Effect.gen(function* () {
        const contextName = "alchemy-test-context-update";

        const first = yield* stack.deploy(
          Docker.Context("updatable-context", {
            name: contextName,
            description: "v1",
            docker: "host=unix:///var/run/docker.sock",
          }),
        );

        const second = yield* stack.deploy(
          Docker.Context("updatable-context", {
            name: contextName,
            description: "v2",
            docker: "host=unix:///var/run/docker.sock",
          }),
        );

        expect(second.id).toBe(first.id);
        expect(second.name).toBe(first.name);
        expect(second.description).toBe("v2");
        expect(extractDockerHost(second.docker)).toBe("unix:///var/run/docker.sock");
      }),
    );

    test.provider("does not plan remote drift for a missing local context", (stack) =>
      Effect.gen(function* () {
        const docker = yield* Docker.Docker;
        const context = Docker.Context("machine-local-context", {
          description: "lives on one machine",
          docker: "host=unix:///var/run/docker.sock",
        });

        yield* stack.destroy();
        const created = yield* stack.deploy(context);
        yield* docker.context.remove(created.name, true);

        const plan = yield* stack.plan(context);
        expect(plan.resources["machine-local-context"]).toMatchObject({ action: "noop" });

        const onFreshRunner = yield* stack.deploy(context);
        expect(onFreshRunner.name).toBe(created.name);
        expect(onFreshRunner.dockerSpec).toBe("host=unix:///var/run/docker.sock");
        const live = yield* docker.network.inspect("bridge", dockerContextTarget(onFreshRunner));
        expect(live.Name).toBe("bridge");
        // The deploy did not mutate the CI runner's Docker CLI configuration.
        const missing = yield* docker.context.inspect(created.name).pipe(Effect.flip);
        expect(missing.reason._tag).toBe("NotFound");

        yield* stack.destroy();
      }),
    );

    test.provider("detects real remote network drift without recreating a CI context", (stack) =>
      Effect.gen(function* () {
        const docker = yield* Docker.Docker;
        const program = Effect.gen(function* () {
          const context = yield* Docker.Context("ci-portable-context", {
            docker: "host=unix:///var/run/docker.sock",
          });
          const network = yield* Docker.Network("ci-managed-network", { context });
          return { context, network };
        });

        yield* stack.destroy();
        const first = yield* stack.deploy(program);
        const target = dockerContextTarget(first.context);
        yield* Effect.addFinalizer(() =>
          docker.network.remove(first.network.name, target).pipe(Effect.ignore),
        );
        yield* Effect.addFinalizer(() =>
          docker.context.remove(first.context.name, true).pipe(Effect.ignore),
        );

        // A fresh runner has no named contexts, but its Engine is reachable.
        yield* docker.context.remove(first.context.name, true);
        const unchanged = yield* stack.plan(program);
        expect(unchanged.resources["ci-portable-context"]).toMatchObject({ action: "noop" });
        expect(unchanged.resources["ci-managed-network"]).toMatchObject({ action: "noop" });
        expect((yield* docker.network.inspect(first.network.name, target)).Id).toBe(
          first.network.id,
        );

        // Actual remote drift must still be observed and reconciled by ID.
        yield* docker.network.remove(first.network.id, target);
        const drift = yield* stack.plan(program);
        expect(drift.resources["ci-portable-context"]).toMatchObject({ action: "noop" });
        expect(drift.resources["ci-managed-network"]).toMatchObject({ action: "update" });
        const repaired = yield* stack.deploy(program);
        expect(repaired.network.id).not.toBe(first.network.id);
        expect((yield* docker.network.inspect(repaired.network.name, target)).Id).toBe(
          repaired.network.id,
        );

        yield* stack.destroy();
      }),
    );

    test.provider("detects remote container drift without a machine-local context", (stack) =>
      Effect.gen(function* () {
        const docker = yield* Docker.Docker;
        const program = Effect.gen(function* () {
          const context = yield* Docker.Context("ci-container-context", {
            docker: "host=unix:///var/run/docker.sock",
          });
          const container = yield* Docker.Container("ci-managed-container", {
            context,
            image: "alpine:3.22",
            start: false,
          });
          return { context, container };
        });

        yield* stack.destroy();
        const first = yield* stack.deploy(program);
        const target = dockerContextTarget(first.context);
        yield* Effect.addFinalizer(() =>
          docker.container.remove(first.container.name, true, target).pipe(Effect.ignore),
        );
        yield* Effect.addFinalizer(() =>
          docker.context.remove(first.context.name, true).pipe(Effect.ignore),
        );
        yield* docker.context.remove(first.context.name, true);

        const stable = yield* stack.plan(program);
        expect(stable.resources["ci-container-context"]).toMatchObject({ action: "noop" });
        expect(stable.resources["ci-managed-container"]).toMatchObject({ action: "noop" });

        yield* docker.container.remove(first.container.name, true, target);
        const drift = yield* stack.plan(program);
        expect(drift.resources["ci-container-context"]).toMatchObject({ action: "noop" });
        expect(drift.resources["ci-managed-container"]).toMatchObject({ action: "update" });

        const repaired = yield* stack.deploy(program);
        expect(repaired.container.id).not.toBe(first.container.id);
        expect((yield* docker.container.inspect(repaired.container.name, target)).Id).toBe(
          repaired.container.id,
        );
        yield* stack.destroy();
      }),
    );

    test.provider("preserves a container during an update on the same managed engine", (stack) =>
      Effect.gen(function* () {
        const docker = yield* Docker.Docker;
        const program = (start: boolean) =>
          Effect.gen(function* () {
            const context = yield* Docker.Context("ci-update-context", {
              docker: "host=unix:///var/run/docker.sock",
            });
            const container = yield* Docker.Container("ci-update-container", {
              context,
              image: "alpine:3.22",
              start,
            });
            return { context, container };
          });

        yield* stack.destroy();
        const first = yield* stack.deploy(program(false));
        const target = dockerContextTarget(first.context);
        yield* Effect.addFinalizer(() =>
          docker.container.remove(first.container.name, true, target).pipe(Effect.ignore),
        );
        yield* Effect.addFinalizer(() =>
          docker.context.remove(first.context.name, true).pipe(Effect.ignore),
        );

        const update = yield* stack.plan(program(true));
        expect(update.resources["ci-update-container"]).toMatchObject({ action: "update" });
        const second = yield* stack.deploy(program(true));
        expect(second.container.id).toBe(first.container.id);
        expect((yield* docker.container.inspect(first.container.name, target)).Id).toBe(
          first.container.id,
        );
        yield* stack.destroy();
      }),
    );

    test.provider("plans a replace when docker endpoint is cleared", (stack) =>
      Effect.gen(function* () {
        const base = Docker.Context("planned-context", {
          description: "with endpoint",
          docker: "host=ssh://user@example.com",
        });

        const changed = Docker.Context("planned-context", { description: "with endpoint" });

        yield* stack.deploy(base);
        const plan = yield* stack.plan(changed);
        expect(plan.resources["planned-context"]).toMatchObject({ action: "replace" });
      }),
    );
  },
);

const extractDockerHost = (docker: unknown): string | undefined => {
  if (typeof docker === "string") {
    return docker.startsWith("host=") ? docker.slice("host=".length) : docker;
  }
  if (typeof docker === "object" && docker !== null && "Host" in docker) {
    const host = (docker as { Host?: unknown }).Host;
    return typeof host === "string" ? host : undefined;
  }
  return undefined;
};
