import * as Docker from "@alchemy.run/docker";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Core from "@alchemy.run/test/Core";
import * as Output from "alchemy/Output";
import { inMemoryState } from "alchemy/State";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

const { test } = Test.make({ providers: Docker.providers(), state: inMemoryState() });

const tags = ["provider:docker", "provider:docker:network", "provider:docker:container", "local"];

// The target belongs to another stack, as a lookup's target always should.
const target = () => Core.scratchStack({ providers: Docker.providers() }, "DockerLookupTarget");

describe.sequential("lookup", () => {
  test.provider(
    "a Container joins a looked-up Network, which survives its destroy",
    (stack) =>
      Effect.gen(function* () {
        const docker = yield* Docker.Docker;
        yield* stack.destroy();
        const owner = target();
        yield* owner.destroy();
        const network = yield* owner.deploy(Docker.Network("lookup-target"));

        const program = Docker.Container("on-looked-up-network", {
          image: "alpine:3.22",
          networks: [{ name: Docker.Network.lookup({ name: network.name }).name }],
          start: false,
        });
        const container = yield* stack.deploy(program);
        const info = yield* docker.container.inspect(container.name);
        expect(Object.keys(info.NetworkSettings.Networks ?? {})).toContain(network.name);

        // A lookup re-resolves to the same Network.
        const plan = yield* stack.plan(program);
        expect(plan.resources["on-looked-up-network"]?.action).toEqual("noop");

        // Destroying the consumer removes the Container, never the Network.
        yield* stack.destroy();
        const after = yield* docker.network.inspect(network.id);
        expect(after.Name).toEqual(network.name);

        yield* owner.destroy();
      }),
    { tags, timeout: 180_000 },
  );

  test.provider(
    "a lookup of a resource that doesn't exist fails the plan",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const missing = "alchemy-lookup-missing";
        const lookups = {
          Network: Docker.Network.lookup({ name: missing }),
          Volume: Docker.Volume.lookup({ name: missing }),
          Container: Docker.Container.lookup({ name: missing }),
          Context: Docker.Context.lookup({ name: missing }),
        } as unknown as Record<string, Output.Output<unknown>>;

        const mismatches: Record<string, string> = {};
        for (const [id, lookup] of Object.entries(lookups)) {
          const exit = yield* Effect.exit(
            stack.plan(Docker.Volume(id, { labels: { value: Output.interpolate`${lookup}` } })),
          );
          const pretty = Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "plan succeeded";
          if (!pretty.includes("LookupNotFoundError")) {
            mismatches[id] = pretty.split("\n")[0]!.slice(0, 300);
          }
        }
        expect(mismatches).toEqual({});
      }),
    { tags, timeout: 120_000 },
  );
});
