import { expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Provider from "@/Provider";
import { Stack } from "@/Stack";
import { Stage } from "@/Stage";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { withControlledClient } from "./fixtures/protocol-branches.ts";
import { Machine, MachineProvider } from "@/Fly/Machine";

import type { MachineProps } from "@/Fly/Machine";
import {
  sameContainerWorkload,
  sameContainers,
  toFlyContainers,
  validateMachineContainers,
} from "@/Fly/MachineContainers";

const noRequests = HttpClient.make((request) =>
  Effect.die(
    new Error(`Unexpected Fly request: ${request.method} ${request.url}`),
  ),
);

const base = {
  containers: [
    {
      name: "api",
      image: "example/api:v1",
      healthChecks: [{ http: { port: 3000, path: "/health" }, interval: 5 }],
    },
    {
      name: "worker",
      image: "example/worker:v1",
      dependsOn: [{ name: "api", condition: "healthy" as const }],
    },
  ],
};

it.effect("maps named containers and checks to Fly config", () =>
  Effect.sync(() => {
    const mapped = toFlyContainers(base.containers);
    expect(mapped[0]?.healthchecks?.[0]).toMatchObject({
      http: { port: 3000, path: "/health" },
      interval: 5,
    });
    expect(mapped[1]?.depends_on).toEqual([
      { name: "api", condition: "healthy" },
    ]);
    expect(mapped[0]?.image).toBe("example/api:v1");
  }),
);

it.effect("rejects malformed inputs before reconciliation", () =>
  Effect.gen(function* () {
    const invalid: Array<Pick<MachineProps, "image" | "containers" | "init">> =
      [
        { ...base, image: "example:latest" },
        { ...base, init: { cmd: ["run"] } },
        { ...base, containers: [] },
        { ...base, containers: [{ name: "api", image: "" }] },
        {
          ...base,
          containers: [
            { name: "api", image: "one" },
            { name: "api", image: "two" },
          ],
        },
        {
          ...base,
          containers: [
            { name: "worker", image: "one", dependsOn: [{ name: "absent" }] },
          ],
        },
        {},
        { image: "   " },
      ];
    for (const props of invalid) {
      const error = yield* validateMachineContainers(props).pipe(Effect.flip);
      expect(error._tag).toBe("Fly.InvalidMachineContainers");
    }
  }),
);

it.effect(
  "compares membership and declared fields independent of container order",
  () =>
    Effect.sync(() => {
      const desired = toFlyContainers(base.containers);
      expect(sameContainers([...desired].reverse(), desired)).toBe(true);
      expect(
        sameContainerWorkload(
          { image: desired[0]?.image, containers: desired },
          desired,
        ),
      ).toBe(true);
      expect(sameContainers(desired.slice(0, 1), desired)).toBe(false);
      expect(
        sameContainers(
          [...desired, { name: "extra", image: "example/extra:v1" }],
          desired,
        ),
      ).toBe(false);
      expect(
        sameContainers(
          [{ ...desired[0], image: "example/api:v2" }, desired[1]!],
          desired,
        ),
      ).toBe(false);
      expect(
        sameContainers(
          [{ ...desired[0], env: { EXTRA: "yes" } }, desired[1]!],
          desired,
        ),
      ).toBe(false);
      expect(
        sameContainers(
          [{ ...desired[0], healthchecks: [] }, desired[1]!],
          desired,
        ),
      ).toBe(false);
      expect(
        sameContainers(
          [{ ...desired[0], cmd: ["serve"] }, desired[1]!],
          desired,
        ),
      ).toBe(false);
      expect(
        sameContainers(
          [
            {
              ...desired[0],
              depends_on: [{ name: "worker", condition: "started" }],
            },
            desired[1]!,
          ],
          desired,
        ),
      ).toBe(false);
      expect(
        sameContainers(
          [desired[0]!, { ...desired[1], depends_on: [] }],
          desired,
        ),
      ).toBe(false);
      expect(
        sameContainers(
          [
            { ...desired[0], healthchecks: [{ http: { port: 3001 } }] },
            desired[1]!,
          ],
          desired,
        ),
      ).toBe(false);
      expect(
        sameContainers([{ ...desired[0], cmd: [] }, desired[1]!], desired),
      ).toBe(false);
      expect(
        sameContainers([{ ...desired[0], env: {} }, desired[1]!], desired),
      ).toBe(true);
    }),
);

it.effect(
  "provider diff rejects malformed JavaScript containers before wire mapping",
  () =>
    Effect.gen(function* () {
      const provider = yield* Provider.Provider<Machine>("Fly.Machine");
      for (const containers of [null, [null]]) {
        const result = yield* provider.diff!({
          id: "Worker",
          fqn: "pure/Worker",
          instanceId: "fixture-instance",
          // @ts-expect-error deliberate malformed JavaScript props at the provider boundary
          news: { app: undefined, containers },
          // @ts-expect-error the prior state is absent on initial create
          olds: undefined,
          oldBindings: [],
          newBindings: [],
          output: undefined,
        }).pipe(Effect.result);
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result))
          expect(result.failure._tag).toBe("Fly.InvalidMachineContainers");
      }
    }).pipe(
      Effect.provide(MachineProvider()),
      withControlledClient(noRequests),
      Effect.provideService(Stack, {
        name: "review-app",
        stage: "pure",
        resources: {},
        bindings: {},
        actions: {},
      }),
      Effect.provideService(Stage, "pure"),
    ),
);

it.effect(
  "provider diff validates resolved containers with an unrelated unresolved app",
  () =>
    Effect.gen(function* () {
      const provider = yield* Provider.Provider<Machine>("Fly.Machine");
      const result = yield* provider.diff!({
        id: "Worker",
        fqn: "pure/Worker",
        instanceId: "fixture-instance",
        // @ts-expect-error deliberate malformed JavaScript container with unresolved app
        news: { app: Effect.succeed("review-app"), containers: [null] },
        // @ts-expect-error the prior state is absent on initial create
        olds: undefined,
        oldBindings: [],
        newBindings: [],
        output: undefined,
      }).pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result))
        expect(result.failure._tag).toBe("Fly.InvalidMachineContainers");
    }).pipe(
      Effect.provide(MachineProvider()),
      withControlledClient(noRequests),
      Effect.provideService(Stack, {
        name: "review-app",
        stage: "pure",
        resources: {},
        bindings: {},
        actions: {},
      }),
      Effect.provideService(Stage, "pure"),
    ),
);

it.effect(
  "provider diff waits for unresolved image mode before mapping containers",
  () =>
    Effect.gen(function* () {
      const provider = yield* Provider.Provider<Machine>("Fly.Machine");
      const result = yield* provider.diff!({
        id: "Worker",
        fqn: "pure/Worker",
        instanceId: "fixture-instance",
        // @ts-expect-error deliberate unresolved image and malformed JavaScript containers
        news: {
          app: "review-app",
          image: Effect.succeed("example:v1"),
          containers: [null],
        },
        // @ts-expect-error the prior state is absent on initial create
        olds: undefined,
        oldBindings: [],
        newBindings: [],
        output: undefined,
      }).pipe(Effect.result);
      expect(Result.isSuccess(result)).toBe(true);
    }).pipe(
      Effect.provide(MachineProvider()),
      withControlledClient(noRequests),
      Effect.provideService(Stack, {
        name: "review-app",
        stage: "pure",
        resources: {},
        bindings: {},
        actions: {},
      }),
      Effect.provideService(Stage, "pure"),
    ),
);
