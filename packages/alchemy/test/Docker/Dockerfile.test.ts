import { imageSourceKind, validateImageSource } from "@/AWS/ECR/ImageSource.ts";
import {
  buildFinalDockerfile,
  containerEnvPreamble,
  validateContainerImageProps,
} from "@/Cloudflare/Containers/ContainerBundle.ts";
import * as Dockerfile from "@/Docker/Dockerfile.ts";
import * as Output from "@/Output.ts";
import { describe, expect, it, test } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

describe("Dockerfile.inline", () => {
  test("no interpolations produce plain string content", () => {
    const df = Dockerfile.inline`FROM oven/bun:1
RUN apt-get install -y ffmpeg`;
    expect(Dockerfile.isInlineDockerfile(df)).toBe(true);
    expect(typeof df.content).toBe("string");
    expect(df.content).toContain("FROM oven/bun:1");
    expect(df.content).toContain("RUN apt-get install -y ffmpeg");
  });

  test("content is deterministic across constructions", () => {
    const a = Dockerfile.inline`FROM oven/bun:1`;
    const b = Dockerfile.inline`FROM oven/bun:1`;
    expect(a.content).toBe(b.content);
  });

  test("interpolations produce Output content (dependency edge)", () => {
    const df = Dockerfile.inline`FROM ${Output.literal("oven/bun:1")}
RUN echo hi`;
    expect(Dockerfile.isInlineDockerfile(df)).toBe(true);
    expect(Output.isOutput(df.content)).toBe(true);
  });

  test("isInlineDockerfile rejects path strings", () => {
    expect(Dockerfile.isInlineDockerfile("./Dockerfile")).toBe(false);
    expect(Dockerfile.isInlineDockerfile(undefined)).toBe(false);
    expect(Dockerfile.isInlineDockerfile(null)).toBe(false);
  });
});

describe("AWS ImageSource composition", () => {
  test("main wins as the source kind; other fields describe its environment", () => {
    expect(imageSourceKind({ main: "./index.ts" })).toBe("main");
    expect(imageSourceKind({ main: "./index.ts", image: "oven/bun:1" })).toBe(
      "main",
    );
    expect(imageSourceKind({ image: "busybox:stable" })).toBe("image");
    expect(imageSourceKind({ context: "./app" })).toBe("context");
    expect(
      imageSourceKind({ dockerfile: Dockerfile.inline`FROM alpine` }),
    ).toBe("context");
    expect(imageSourceKind({})).toBeUndefined();
  });

  it.effect("validateImageSource dies on exclusivity violations", () =>
    Effect.gen(function* () {
      const dies = (source: Parameters<typeof validateImageSource>[1]) =>
        Effect.gen(function* () {
          const result = yield* Effect.result(
            validateImageSource("T", source).pipe(
              Effect.catchDefect((defect) => Effect.fail(defect as Error)),
            ),
          );
          return Result.isFailure(result);
        });

      expect(
        yield* dies({ image: "busybox", dockerfile: "./Dockerfile" }),
      ).toBe(true);
      expect(yield* dies({ image: "busybox", context: "./app" })).toBe(true);
      expect(
        yield* dies({
          dockerfile: Dockerfile.inline`FROM alpine`,
          context: "./app",
        }),
      ).toBe(true);
      // Valid combinations pass.
      expect(yield* dies({ main: "./i.ts", image: "oven/bun:1" })).toBe(false);
      expect(
        yield* dies({ main: "./i.ts", dockerfile: Dockerfile.inline`FROM x` }),
      ).toBe(false);
      expect(
        yield* dies({ context: "./app", dockerfile: "./app/Dockerfile" }),
      ).toBe(false);
    }),
  );
});

describe("Cloudflare container environment composition", () => {
  test("containerEnvPreamble: image ref becomes FROM line", () => {
    expect(containerEnvPreamble({ image: "oven/bun:1" })).toBe(
      "FROM oven/bun:1",
    );
    expect(containerEnvPreamble({})).toBeUndefined();
  });

  test("containerEnvPreamble: inline content used verbatim", () => {
    const preamble = containerEnvPreamble({
      dockerfile: Dockerfile.inline`FROM oven/bun:1
RUN apt-get install -y ffmpeg`,
    });
    expect(preamble).toContain("RUN apt-get install -y ffmpeg");
  });

  test("containerEnvPreamble: rejects Dockerfile content passed as image", () => {
    expect(() =>
      containerEnvPreamble({ image: "FROM oven/bun:1\nRUN echo hi" }),
    ).toThrow(/plain image reference/);
  });

  test("buildFinalDockerfile layers the bundle on top of the preamble", () => {
    const dockerfile = buildFinalDockerfile(
      "FROM oven/bun:1\nRUN apt-get install -y ffmpeg",
      "bun",
    );
    const lines = dockerfile.split("\n");
    expect(lines[0]).toBe("FROM oven/bun:1");
    expect(lines[1]).toBe("RUN apt-get install -y ffmpeg");
    expect(dockerfile).toContain("COPY index.mjs /app/index.mjs");
    expect(dockerfile).toContain('ENTRYPOINT ["bun", "/app/index.mjs"]');
  });

  test("buildFinalDockerfile falls back to the runtime default base", () => {
    expect(buildFinalDockerfile(undefined, "bun").split("\n")[0]).toBe(
      "FROM oven/bun:1",
    );
    expect(buildFinalDockerfile(undefined, "node").split("\n")[0]).toBe(
      "FROM node:22-slim",
    );
  });

  test("validateContainerImageProps enforces exclusivity", () => {
    // main + image and main + inline dockerfile are the two environments.
    expect(() =>
      validateContainerImageProps({ main: "./i.ts", image: "oven/bun:1" }),
    ).not.toThrow();
    expect(() =>
      validateContainerImageProps({
        main: "./i.ts",
        dockerfile: Dockerfile.inline`FROM x`,
      }),
    ).not.toThrow();
    expect(() =>
      validateContainerImageProps({
        main: "./i.ts",
        image: "oven/bun:1",
        dockerfile: Dockerfile.inline`FROM x`,
      }),
    ).toThrow(/mutually exclusive/);
    // A path dockerfile cannot be an environment on Cloudflare.
    expect(() =>
      validateContainerImageProps({
        main: "./i.ts",
        dockerfile: "./Dockerfile",
      }),
    ).toThrow(/PATH/);
    expect(() =>
      validateContainerImageProps({ main: "./i.ts", context: "./app" }),
    ).toThrow(/context/);
    // Without main: image is exclusive with dockerfile/context.
    expect(() =>
      validateContainerImageProps({ image: "busybox", dockerfile: "./f" }),
    ).toThrow(/mutually exclusive/);
    expect(() =>
      validateContainerImageProps({ image: "busybox", context: "./app" }),
    ).toThrow(/mutually exclusive/);
    // Inline content has no build context.
    expect(() =>
      validateContainerImageProps({
        dockerfile: Dockerfile.inline`FROM x`,
        context: "./app",
      }),
    ).toThrow(/no build context/);
    // The plain external build stays valid.
    expect(() =>
      validateContainerImageProps({
        context: "./app",
        dockerfile: "./app/Dockerfile",
      }),
    ).not.toThrow();
  });
});
