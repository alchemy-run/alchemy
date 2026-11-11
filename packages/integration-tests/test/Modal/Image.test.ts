import * as Dockerfile from "@alchemy.run/docker/Dockerfile";
import * as Modal from "@alchemy.run/modal";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as image from "@distilled.cloud/modal/image";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

const { test } = Test.make({ providers: Modal.providers() });

test.provider(
  "build an image, a warm base from it, and rebuild on change",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* Modal.App("ImageApp", {});
          const base = yield* Modal.Image("Base", {
            app,
            image: "debian:bookworm-slim",
            commands: ["RUN echo base > /base.txt"],
          });
          const warm = yield* Modal.Image("Warm", {
            app,
            from: base,
            run: ["echo warm > /warm.txt"],
          });
          return { base, warm };
        }),
      );
      expect(deployed.base.imageId).toMatch(/^im-/);
      expect(deployed.warm.imageId).not.toBe(deployed.base.imageId);
      expect((yield* image.imageFromId({ imageId: deployed.warm.imageId })).imageId).toBe(
        deployed.warm.imageId,
      );

      const changed = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* Modal.App("ImageApp", {});
          const base = yield* Modal.Image("Base", {
            app,
            image: "debian:bookworm-slim",
            commands: ["RUN echo changed > /base.txt"],
          });
          const warm = yield* Modal.Image("Warm", {
            app,
            from: base,
            run: ["echo warm > /warm.txt"],
          });
          return { base, warm };
        }),
      );
      expect(changed.base.imageId).not.toBe(deployed.base.imageId);
      expect(changed.warm.imageId).not.toBe(deployed.warm.imageId);

      yield* stack.destroy();
    }),
  { tags: ["provider:modal", "provider:modal:image", "live"], timeout: 600_000 },
);

test.provider(
  "a Dockerfile instruction Modal can't run fails at plan",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const result = yield* stack
        .deploy(
          Effect.gen(function* () {
            const app = yield* Modal.App("BadImageApp", {});
            return yield* Modal.Image("Bad", {
              app,
              dockerfile: Dockerfile.inline`
                FROM debian:bookworm-slim
                HEALTHCHECK CMD true
              `,
            });
          }),
        )
        .pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
      expect(String(Result.isFailure(result) ? JSON.stringify(result.failure) : "")).toContain(
        "HEALTHCHECK",
      );
      yield* stack.destroy();
    }),
  { tags: ["provider:modal", "provider:modal:image", "live"], timeout: 120_000 },
);
