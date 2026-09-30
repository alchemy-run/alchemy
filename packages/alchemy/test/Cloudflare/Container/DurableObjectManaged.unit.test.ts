import { durableObjectImageSources } from "@/Cloudflare/Containers/ContainerBundle.ts";
import { uploadContainerMetadata } from "@/Cloudflare/Workers/WorkerProvider";
import { describe, expect, it, test } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

const binding = (containers: unknown) =>
  ({ sid: "b", data: { containers } }) as any;

describe(
  "Durable Object-managed containers",
  {
    tags: [
      "unit",
      "provider:cloudflare",
      "provider:cloudflare:container",
      "local",
    ],
  },
  () => {
    describe("durableObjectImageSources", () => {
      it.effect("publishes each named image to its own repository", () =>
        Effect.gen(function* () {
          const sources = yield* durableObjectImageSources(
            {
              schedulingPolicy: "durable_object",
              images: {
                node: { context: "./node" },
                python: { image: "python:3.13-slim" },
              },
            },
            "sandbox",
          );
          expect(sources.map(([name]) => name)).toEqual(["node", "python"]);
          expect(sources[0]![1]).toMatchObject({
            context: "./node",
            image: undefined,
            publish: { repository: "sandbox-node" },
          });
          expect(sources[1]![1]).toMatchObject({
            image: "python:3.13-slim",
            context: undefined,
            publish: { repository: "sandbox-python" },
          });
        }),
      );

      it.effect("publishes the container's own image as default", () =>
        Effect.gen(function* () {
          const sources = yield* durableObjectImageSources(
            {
              schedulingPolicy: "durable_object",
              image: "node:24-slim",
              images: { python: { image: "python:3.13-slim" } },
            },
            "sandbox",
          );
          expect(sources.map(([name]) => name)).toEqual(["default", "python"]);
          expect(sources[0]![1].image).toBe("node:24-slim");
        }),
      );

      for (const [label, props] of [
        ["declares no image", { schedulingPolicy: "durable_object" }],
        [
          "bundles main",
          {
            schedulingPolicy: "durable_object",
            main: "file:///app.ts",
            images: { a: { image: "x" } },
          },
        ],
        [
          "shadows its own image with images.default",
          {
            schedulingPolicy: "durable_object",
            image: "a",
            images: { default: { image: "b" } },
          },
        ],
      ] as const) {
        it.effect(`refuses a container that ${label}`, () =>
          Effect.gen(function* () {
            const exit = yield* Effect.exit(
              durableObjectImageSources(props as any, "sandbox"),
            );
            expect(Exit.isFailure(exit)).toBe(true);
          }),
        );
      }
    });

    describe("uploadContainerMetadata", () => {
      test("declares the application name and images beside the class", () => {
        const metadata = uploadContainerMetadata([
          binding([
            {
              className: "Sandbox",
              dev: undefined,
              hash: "h",
              name: "sandbox-app",
              images: { node: "registry.cloudflare.com/a/node@sha256:1" },
            },
          ]),
        ]);
        expect(metadata.get("Sandbox")).toEqual({
          className: "Sandbox",
          name: "sandbox-app",
          images: { node: "registry.cloudflare.com/a/node@sha256:1" },
        });
      });

      test("leaves a legacy or unresolved container class-only", () => {
        const metadata = uploadContainerMetadata([
          binding([
            // Legacy: the application carries its own image.
            { className: "Legacy", dev: undefined, hash: "h", name: "legacy" },
            // Precreate: images not resolved yet.
            {
              className: "Pending",
              dev: undefined,
              hash: "h",
              name: "pending",
              images: { node: { kind: "Output" } },
            },
          ]),
        ]);
        expect(metadata.size).toBe(0);
      });
    });
  },
);
