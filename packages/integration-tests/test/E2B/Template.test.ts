import * as E2B from "@alchemy.run/e2b";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as templates from "@distilled.cloud/e2b/templates";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: E2B.providers() });

const expectTemplateGone = (templateId: string) =>
  templates.getTemplate({ templateID: templateId }).pipe(
    Effect.map(() => true),
    Effect.catchTag("NotFound", () => Effect.succeed(false)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (exists) => !exists,
      times: 15,
    }),
    Effect.map((exists) => expect(exists).toBe(false)),
  );

test.provider(
  "build from an image, rebuild on a changed step, skip an unchanged redeploy, and delete",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* E2B.Template("Base", {
            image: "ubuntu:24.04",
            run: ["echo one > /tmp/marker"],
          });
        }),
      );
      const built = yield* templates.getTemplate({ templateID: first.templateId });
      expect(built.buildStatus).toBe("ready");
      expect(first.buildHash).toHaveLength(64);

      // Unchanged inputs: no new build.
      const same = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* E2B.Template("Base", {
            image: "ubuntu:24.04",
            run: ["echo one > /tmp/marker"],
          });
        }),
      );
      expect(same.buildId).toBe(first.buildId);

      // A changed step: a new build of the same template.
      const second = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* E2B.Template("Base", {
            image: "ubuntu:24.04",
            run: ["echo two > /tmp/marker"],
          });
        }),
      );
      expect(second.templateId).toBe(first.templateId);
      expect(second.buildId).not.toBe(first.buildId);
      expect(second.buildHash).not.toBe(first.buildHash);

      yield* stack.destroy();
      yield* expectTemplateGone(first.templateId);
    }),
  { tags: ["provider:e2b", "provider:e2b:template", "live"], timeout: 600_000 },
);

test.provider(
  "build from a Dockerfile with a COPY context, and rebuild when a context file changes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const context = yield* fs.makeTempDirectoryScoped({ prefix: "e2b-template-" });
      yield* fs.writeFileString(path.join(context, "hello.txt"), "hello v1\n");
      yield* fs.writeFileString(
        path.join(context, "Dockerfile"),
        'FROM ubuntu:24.04\nCOPY hello.txt /opt/hello.txt\nCMD ["sleep", "infinity"]\n',
      );
      const props = { context, dockerfile: path.join(context, "Dockerfile") };

      const first = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* E2B.Template("FromDockerfile", props);
        }),
      );

      yield* fs.writeFileString(path.join(context, "hello.txt"), "hello v2\n");
      const second = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* E2B.Template("FromDockerfile", props);
        }),
      );
      expect(second.buildId).not.toBe(first.buildId);
      expect(second.buildHash).not.toBe(first.buildHash);

      yield* stack.destroy();
      yield* expectTemplateGone(first.templateId);
    }).pipe(Effect.scoped),
  { tags: ["provider:e2b", "provider:e2b:template", "live"], timeout: 600_000 },
);

test.provider(
  "a multi-stage Dockerfile fails at plan with a typed error and creates nothing",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const error = yield* stack
        .deploy(
          Effect.gen(function* () {
            return yield* E2B.Template("MultiStage", {
              dockerfile: {
                content:
                  "FROM node:22 AS build\nRUN echo hi\nFROM node:22-slim\nCOPY --from=build /a /a\n",
              },
            });
          }),
        )
        .pipe(Effect.flip);
      expect(String(error)).toContain("multi-stage builds are not supported");
      yield* stack.destroy();
    }),
  { tags: ["provider:e2b", "provider:e2b:template", "live"], timeout: 120_000 },
);
