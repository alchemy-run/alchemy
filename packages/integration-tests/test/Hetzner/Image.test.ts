import * as Hetzner from "@alchemy.run/hetzner";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as images from "@distilled.cloud/hetzner/images";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { hetznerPrimaryIps } from "./limit.ts";
import { expectFound } from "./lookup.ts";

const { test } = Test.make({ limit: hetznerPrimaryIps, providers: Hetzner.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const waitUntilGone = (id: number) =>
  images.getImage({ id }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "create, update, and delete a snapshot image",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const server = yield* Hetzner.Server("Web", {
            serverType: "cpx12",
            image: "ubuntu-24.04",
            location: "nbg1",
          });
          return yield* Hetzner.Image("Golden", {
            server,
            description: "alchemy-image-golden",
            labels: { env: "test" },
          });
        }),
      );
      yield* expectFound(Hetzner.Image.lookup({ id: created.id }), created);

      expect(created.id).toEqual(expect.any(Number));
      expect(created.type).toEqual("snapshot");
      expect(created.status).toEqual("available");
      expect(created.description).toEqual("alchemy-image-golden");
      expect(created.createdFromId).toEqual(expect.any(Number));
      expect(created.diskSize).toEqual(expect.any(Number));
      expect(created.architecture).toEqual("x86");
      expect(created.deleteProtection).toEqual(false);
      expect(created.labels).toMatchObject({ env: "test" });

      const fetched = yield* images.getImage({ id: created.id });
      expect(fetched.image?.id).toEqual(created.id);
      expect(fetched.image?.type).toEqual("snapshot");
      expect(fetched.image?.status).toEqual("available");
      expect(fetched.image?.description).toEqual("alchemy-image-golden");
      expect(fetched.image?.created_from?.id).toEqual(created.createdFromId);
      expect(fetched.image?.labels.env).toEqual("test");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const server = yield* Hetzner.Server("Web", {
            serverType: "cpx12",
            image: "ubuntu-24.04",
            location: "nbg1",
          });
          return yield* Hetzner.Image("Golden", {
            server,
            description: "alchemy-image-golden-v2",
            labels: { env: "prod", role: "golden" },
          });
        }),
      );

      expect(updated.id).toEqual(created.id);
      expect(updated.createdFromId).toEqual(created.createdFromId);
      expect(updated.description).toEqual("alchemy-image-golden-v2");
      expect(updated.labels).toMatchObject({ env: "prod", role: "golden" });

      const refetched = yield* images.getImage({ id: updated.id });
      expect(refetched.image?.id).toEqual(created.id);
      expect(refetched.image?.description).toEqual("alchemy-image-golden-v2");
      expect(refetched.image?.labels.env).toEqual("prod");
      expect(refetched.image?.labels.role).toEqual("golden");

      const provider = yield* Provider.findProvider(Hetzner.Image);
      const all = yield* provider.list();
      const found = all.find((image) => image.id === created.id);
      expect(found).toBeDefined();
      expect(found?.description).toEqual("alchemy-image-golden-v2");
      expect(found?.type).toEqual("snapshot");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.id);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: [
      "provider:hetzner",
      "provider:hetzner:image",
      "provider:hetzner:server",
      "provider:hetzner:service",
      "live",
    ],
    timeout: 180_000,
  },
);

test.provider(
  "replace when the source server changes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Both servers stay deployed across the replacement, so the image
      // replacement never runs alongside removing its old dependency.
      const program = (source: "First" | "Second") =>
        Effect.gen(function* () {
          const first = yield* Hetzner.Server("First", {
            serverType: "cpx12",
            image: "ubuntu-24.04",
            location: "nbg1",
          });
          const second = yield* Hetzner.Server("Second", {
            serverType: "cpx12",
            image: "ubuntu-24.04",
            location: "nbg1",
          });
          const image = yield* Hetzner.Image("Snapshot", {
            server: source === "First" ? first : second,
          });
          return { first, second, image };
        });

      const created = yield* stack.deploy(program("First"));
      expect(created.image.createdFromId).toEqual(created.first.id);

      const replaced = yield* stack.deploy(program("Second"));
      expect(replaced.image.id).not.toEqual(created.image.id);
      expect(replaced.image.createdFromId).toEqual(replaced.second.id);

      const fetched = yield* images.getImage({ id: replaced.image.id });
      expect(fetched.image?.created_from?.id).toEqual(replaced.second.id);
      expect(yield* waitUntilGone(created.image.id)).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitUntilGone(replaced.image.id)).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: [
      "provider:hetzner",
      "provider:hetzner:image",
      "provider:hetzner:server",
      "provider:hetzner:service",
      "live",
    ],
    timeout: 240_000,
  },
);
