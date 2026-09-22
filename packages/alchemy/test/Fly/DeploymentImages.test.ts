import { expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  applyImageSet,
  decodeImageSet,
  encodeImageSet,
  isImmutableImage,
  pinsFromConfig,
  sameImageSet,
  validObservedImageSet,
} from "@/Fly/DeploymentImages";

const digestA = `registry.example.com/api@sha256:${"a".repeat(64)}`;
const digestB = `registry.example.com/worker@sha256:${"b".repeat(64)}`;
const pins = [
  { name: "api", image: digestA },
  { name: "worker", image: digestB },
];

it.effect("requires complete immutable and unique image sets", () =>
  Effect.sync(() => {
    expect(isImmutableImage(digestA)).toBe(true);
    expect(isImmutableImage(`${digestA}:latest`)).toBe(false);
    expect(isImmutableImage("registry.example.com/api:latest")).toBe(false);
    expect(
      pinsFromConfig({
        containers: [
          { name: "api", image: digestA },
          { name: "worker", image: digestB },
        ],
      }),
    ).toEqual(pins);
    expect(
      pinsFromConfig({
        containers: [
          { name: "api", image: digestA },
          { name: "api", image: digestB },
        ],
      }),
    ).toBeUndefined();
    expect(
      pinsFromConfig({
        containers: [{ name: "api", image: digestA }, { name: "worker" }],
      }),
    ).toBeUndefined();
    expect(
      pinsFromConfig({ containers: [{ name: "api", image: "api:latest" }] }),
    ).toBeUndefined();
    expect(
      sameImageSet(
        [{ name: "api", image: "bad" }],
        [{ name: "api", image: "bad" }],
      ),
    ).toBe(false);
  }),
);

it.effect(
  "decodes metadata by membership independent of JSON order and spacing",
  () =>
    Effect.sync(() => {
      const encoded = encodeImageSet([...pins].reverse());
      expect(encoded).toBe(JSON.stringify(pins));
      expect(
        decodeImageSet(JSON.stringify([...pins].reverse(), null, 2)),
      ).toEqual(pins);
      expect(decodeImageSet("{not json")).toBeUndefined();
      expect(
        decodeImageSet(JSON.stringify([pins[0], pins[0]])),
      ).toBeUndefined();
      expect(sameImageSet([...pins].reverse(), pins)).toBe(true);
      expect(sameImageSet(pins.slice(0, 1), pins)).toBe(false);
    }),
);

it.effect("requires protocol-2 metadata to match authoritative readback", () =>
  Effect.sync(() => {
    const config = {
      image: digestA, // Fly synthesizes the first container as a top-level image.
      containers: [
        { name: "api", image: digestA },
        { name: "worker", image: digestB },
      ],
      metadata: {
        "alchemy.deployment-protocol": "2",
        "alchemy.container-image-set": JSON.stringify(pins),
      },
    };
    expect(validObservedImageSet({ config })).toBe(true);
    expect(
      validObservedImageSet({
        config: { ...config, containers: config.containers.slice(0, 1) },
      }),
    ).toBe(false);
    expect(
      validObservedImageSet({
        config: {
          ...config,
          metadata: { ...config.metadata, "alchemy.image": digestA },
        },
      }),
    ).toBe(false);
    expect(
      validObservedImageSet({
        config: {
          ...config,
          metadata: { ...config.metadata, "alchemy.deployment-protocol": "1" },
        },
      }),
    ).toBe(false);
    expect(
      validObservedImageSet({
        config: {
          ...config,
          metadata: {
            ...config.metadata,
            "alchemy.container-image-set": "broken",
          },
        },
      }),
    ).toBe(false);
  }),
);

it.effect(
  "applies every pin and rejects mismatched or duplicate container membership",
  () =>
    Effect.sync(() => {
      const config = {
        containers: [
          { name: "worker", image: "worker:tag" },
          { name: "api", image: "api:tag" },
        ],
      };
      expect(
        applyImageSet(config, pins)?.containers?.map(({ image }) => image),
      ).toEqual([digestB, digestA]);
      expect(
        applyImageSet({ containers: [{ name: "api" }] }, pins),
      ).toBeUndefined();
      expect(
        applyImageSet({ containers: [{ name: "api" }, { name: "api" }] }, pins),
      ).toBeUndefined();
    }),
);
