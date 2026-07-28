import { adopt, OwnedBySomeoneElse } from "@/AdoptPolicy";
import * as Docker from "@/Docker";
import * as Provider from "@/Provider";
import { inMemoryState } from "@/State";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { isDockerSwarmReady } from "./Runtime.ts";

const { test } = Test.make({
  providers: Docker.providers(),
  state: inMemoryState(),
});

test.provider("diff replaces a service when replicas change", () =>
  Effect.gen(function* () {
    const serviceProvider = yield* Provider.findProvider(Docker.Service);
    const serviceDiff = yield* serviceProvider.diff!({
      id: "web",
      fqn: "web",
      instanceId: "instance",
      olds: {
        name: "web",
        image: "nginx:alpine",
        replicas: 1,
      },
      news: {
        name: "web",
        image: "nginx:alpine",
        replicas: 2,
      },
      oldBindings: [],
      newBindings: [],
      output: {
        id: "service-id-1",
        name: "web",
        image: "nginx:alpine",
        replicas: 1,
        networks: [],
        ports: [],
        labels: {},
        endpointMode: "vip",
        createdAt: 0,
        updatedAt: 0,
      },
    });
    expect(serviceDiff).toEqual({ action: "replace", deleteFirst: true });
  }),
);

test.provider("diff replaces a service when its Docker context changes", () =>
  Effect.gen(function* () {
    const serviceProvider = yield* Provider.findProvider(Docker.Service);
    const serviceDiff = yield* serviceProvider.diff!({
      id: "web",
      fqn: "web",
      instanceId: "instance",
      olds: {
        name: "web",
        image: "nginx:alpine",
        context: "default",
      },
      news: {
        name: "web",
        image: "nginx:alpine",
        context: "remote-build",
      },
      oldBindings: [],
      newBindings: [],
      output: {
        id: "service-id-1",
        name: "web",
        context: "default",
        image: "nginx:alpine",
        replicas: 1,
        networks: [],
        ports: [],
        labels: {},
        endpointMode: "vip",
        createdAt: 0,
        updatedAt: 0,
      },
    });
    expect(serviceDiff).toEqual({ action: "replace", deleteFirst: true });
  }),
);

describe("Docker.Service", { concurrent: false }, () => {
  test.provider.skipIf(!isDockerSwarmReady)(
    "creates a replicated service with labels",
    (stack) =>
      Effect.gen(function* () {
        const serviceName = "alchemy-test-service-create";
        const service = yield* stack.deploy(
          Docker.Service("created-service", {
            name: serviceName,
            image: "nginx:alpine",
            replicas: 1,
            labels: { "com.alchemy.test": "true" },
          }),
        );

        expect(service.name).toBe(serviceName);
        expect(service.id.length).toBeGreaterThan(0);
        expect(service.image).toContain("nginx:alpine");
        expect(service.replicas).toBe(1);
        expect(service.endpointMode).toBe("vip");
        expect(service.labels["com.alchemy.test"]).toBe("true");
      }),
    { timeout: 240_000 },
  );

  test.provider.skipIf(!isDockerSwarmReady)(
    "refuses a pre-existing service unless explicitly adopted",
    (stack) =>
      Effect.gen(function* () {
        const docker = yield* Docker.Docker;
        const serviceName = "alchemy-test-service-adopt-existing";

        yield* Effect.addFinalizer(() =>
          docker.service.remove(serviceName).pipe(Effect.ignore),
        );

        yield* docker.service
          .remove(serviceName)
          .pipe(
            Effect.catchReason("PlatformError", "NotFound", () => Effect.void),
          );

        yield* docker.service.create({
          name: serviceName,
          image: "nginx:alpine",
          replicas: 1,
        });

        const error = yield* stack
          .deploy(
            Docker.Service("existing-service", {
              name: serviceName,
              image: "nginx:alpine",
              replicas: 1,
            }),
          )
          .pipe(
            Effect.as(undefined),
            Effect.catchCause((cause) => Effect.succeed(findOwnedError(cause))),
          );

        expect(error).toBeInstanceOf(OwnedBySomeoneElse);

        const adopted = yield* stack.deploy(
          Docker.Service("existing-service", {
            name: serviceName,
            image: "nginx:alpine",
            replicas: 1,
          }).pipe(adopt(true)),
        );

        expect(adopted.name).toBe(serviceName);
        expect(adopted.id.length).toBeGreaterThan(0);
      }),
    { timeout: 240_000 },
  );

  test.provider.skipIf(!isDockerSwarmReady)(
    "replaces a service when labels change",
    (stack) =>
      Effect.gen(function* () {
        const serviceName = "alchemy-test-service-replace";

        const first = yield* stack.deploy(
          Docker.Service("replaceable-service", {
            name: serviceName,
            image: "nginx:alpine",
            labels: { generation: "1" },
          }),
        );

        const second = yield* stack.deploy(
          Docker.Service("replaceable-service", {
            name: serviceName,
            image: "nginx:alpine",
            labels: { generation: "2" },
          }),
        );

        expect(second.id).not.toBe(first.id);
        expect(second.labels.generation).toBe("2");
      }),
    { timeout: 240_000 },
  );
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
