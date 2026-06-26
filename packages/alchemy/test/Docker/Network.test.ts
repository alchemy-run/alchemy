import { adopt, OwnedBySomeoneElse } from "@/AdoptPolicy";
import * as Docker from "@/Docker";
import * as Provider from "@/Provider";
import { inMemoryState } from "@/State";
import * as Test from "@/Test/Vitest";
import { expect } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { spawnSync } from "node:child_process";
import { describe } from "vitest";

const dockerDaemonOk =
  spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;

const { test } = Test.make({
  providers: Docker.providers(),
  state: inMemoryState(),
  adopt: true,
});

const { test: nonAdoptTest } = Test.make({
  providers: Docker.providers(),
  state: inMemoryState(),
});

const findOwnedError = (
  cause: Cause.Cause<unknown>,
): OwnedBySomeoneElse | undefined =>
  cause.reasons
    .map((reason) =>
      Cause.isFailReason(reason)
        ? reason.error
        : Cause.isDieReason(reason)
          ? reason.defect
          : undefined,
    )
    .find(
      (value): value is OwnedBySomeoneElse =>
        value instanceof OwnedBySomeoneElse,
    );

test.provider("diff replaces a network when labels change", () =>
  Effect.gen(function* () {
    const networkProvider = yield* Provider.findProvider(Docker.Network);
    const networkDiff = yield* networkProvider.diff!({
      id: "app",
      instanceId: "instance",
      olds: { name: "app", labels: { usage: "old" } },
      news: { name: "app", labels: { usage: "new" } },
      oldBindings: [],
      newBindings: [],
      output: {
        id: "app",
        name: "app",
        driver: "bridge",
        enableIPv6: false,
        labels: { usage: "old" },
        createdAt: 0,
      },
    });
    expect(networkDiff).toEqual({ action: "replace", deleteFirst: true });
  }),
);

describe.sequential("Docker.Network", () => {
  test.provider.skipIf(!dockerDaemonOk)(
    "creates a bridge network",
    (stack) =>
      Effect.gen(function* () {
        const network = yield* stack.deploy(
          Docker.Network("created-network", {
            name: "alchemy-test-network-create",
            labels: { "com.alchemy.test": "true" },
          }),
        );
        expect(network.name).toBe("alchemy-test-network-create");
        expect(network.driver).toBe("bridge");
        expect(network.id.length).toBeGreaterThan(0);
        expect(network.labels["com.alchemy.test"]).toBe("true");
      }),
    { timeout: 120000 },
  );

  nonAdoptTest.provider.skipIf(!dockerDaemonOk)(
    "refuses a pre-existing network unless explicitly adopted",
    (stack) =>
      Effect.gen(function* () {
        const docker = yield* Docker.Docker;
        const networkName = "alchemy-test-network-adoption";
        yield* Effect.addFinalizer(() =>
          docker.network.remove(networkName).pipe(Effect.ignore),
        );
        yield* docker.network
          .remove(networkName)
          .pipe(
            Effect.catchReason("PlatformError", "NotFound", () => Effect.void),
          );
        yield* docker.network.create({ name: networkName, driver: "bridge" });

        const error = yield* stack
          .deploy(Docker.Network("existing-network", { name: networkName }))
          .pipe(
            Effect.as(undefined),
            Effect.catchCause((cause) => Effect.succeed(findOwnedError(cause))),
          );
        expect(error).toBeInstanceOf(OwnedBySomeoneElse);

        const network = yield* stack.deploy(
          Docker.Network("existing-network", { name: networkName }).pipe(
            adopt(true),
          ),
        );
        expect(network.name).toBe(networkName);
        expect(network.id.length).toBeGreaterThan(0);
      }),
    { timeout: 120000 },
  );

  test.provider.skipIf(!dockerDaemonOk)(
    "adopts an existing same-name network with stack adoption",
    (stack) =>
      Effect.gen(function* () {
        const docker = yield* Docker.Docker;
        const networkName = "alchemy-test-network-adopt-existing";
        yield* Effect.addFinalizer(() =>
          docker.network.remove(networkName).pipe(Effect.ignore),
        );
        yield* docker.network
          .remove(networkName)
          .pipe(
            Effect.catchReason("PlatformError", "NotFound", () => Effect.void),
          );
        yield* docker.network.create({ name: networkName, driver: "bridge" });

        const network = yield* stack.deploy(
          Docker.Network("existing-network", {
            name: networkName,
            driver: "bridge",
          }),
        );
        expect(network.name).toBe(networkName);
        expect(network.id.length).toBeGreaterThan(0);
      }),
    { timeout: 120000 },
  );

  test.provider.skipIf(!dockerDaemonOk)(
    "replaces a network when its labels change",
    (stack) =>
      Effect.gen(function* () {
        const docker = yield* Docker.Docker;
        // Auto-generated name: a replacement gets a fresh physical name, so
        // the new network never collides with the one being torn down.
        const name = "alchemy-test-network-replace";
        yield* docker.network
          .remove(name)
          .pipe(
            Effect.catchReason("PlatformError", "NotFound", () => Effect.void),
          );
        const first = yield* stack.deploy(
          Docker.Network("replaceable-network", {
            name,
            labels: { generation: "1" },
          }),
        );
        const second = yield* stack.deploy(
          Docker.Network("replaceable-network", {
            name,
            labels: { generation: "2" },
          }),
        );
        expect(second.id).not.toBe(first.id);
        expect(second.labels.generation).toBe("2");
      }),
    { timeout: 120000 },
  );
});
