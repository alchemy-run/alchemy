import { expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";

import type { MachineProps } from "@/Fly/Machine";
import {
  sameContainerWorkload,
  sameContainers,
  toFlyContainers,
  validateMachineContainers,
} from "@/Fly/MachineContainers";

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
