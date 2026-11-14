import * as zlib from "node:zlib";
import * as Dockerfile from "@alchemy.run/docker/Dockerfile";
import { tarGzip } from "@alchemy.run/e2b/internal/Tar";
import { planTemplateBuild } from "@alchemy.run/e2b/internal/TemplateBuild";
import { planSource } from "@alchemy.run/e2b/internal/TemplatePlan";
import { expect, layer } from "@alchemy.run/test";
import { BunServices } from "@effect/platform-bun";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

const tags = ["unit", "provider:e2b", "local"];

const makeContext = Effect.fn(function* (files: Record<string, string>) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-e2b-plan-" });
  for (const [name, content] of Object.entries(files)) {
    yield* fs.makeDirectory(path.dirname(path.join(root, name)), { recursive: true });
    yield* fs.writeFileString(path.join(root, name), content);
  }
  return { root, fs, path };
});

layer(BunServices.layer)("E2B template plan", (test) => {
  test.effect(
    "lowers a Dockerfile and its context to E2B steps",
    () =>
      Effect.gen(function* () {
        const { root, path } = yield* makeContext({
          Dockerfile: [
            "ARG NODE=22",
            "FROM node:${NODE}-bookworm",
            'ENV A=1 B="two words"',
            "RUN apt-get update && apt-get install -y git",
            "COPY --chown=user:user src/ /app/src/",
            "WORKDIR /app",
            "USER user",
            "EXPOSE 3000",
            'CMD ["node", "server.js"]',
          ].join("\n"),
          "src/index.js": "console.log('hi')",
          "README.md": "not copied",
        });
        const lowered = yield* planSource({
          context: root,
          dockerfile: path.join(root, "Dockerfile"),
        });
        expect(lowered.fromImage).toBe("node:22-bookworm");
        expect(lowered.startCmd).toBe("node server.js");
        const copy = lowered.steps.find((step) => step.type === "COPY")!;
        expect(lowered.steps.map(({ type, args }) => ({ type, args }))).toEqual([
          { type: "USER", args: ["root"] },
          { type: "WORKDIR", args: ["/"] },
          { type: "ENV", args: ["A", "1", "B", "two words"] },
          { type: "RUN", args: ["apt-get update && apt-get install -y git"] },
          { type: "COPY", args: ["src/", "/app/src/", "user:user", ""] },
          { type: "WORKDIR", args: ["/app"] },
          { type: "USER", args: ["user"] },
        ]);
        expect(lowered.uploads.get(copy.filesHash!)?.map((file) => file.path)).toEqual([
          "src/index.js",
        ]);
      }),
    { tags },
  );

  test.effect(
    "ends as `user` in /home/user like E2B, unless the Dockerfile says otherwise",
    () =>
      Effect.gen(function* () {
        const lowered = yield* planSource({
          dockerfile: Dockerfile.inline`FROM ubuntu:24.04
RUN echo hi`,
        });
        expect(lowered.steps.slice(-2)).toEqual([
          { type: "USER", args: ["user"] },
          { type: "WORKDIR", args: ["/home/user"] },
        ]);
      }),
    { tags },
  );

  test.effect(
    "build args override ARG defaults, and a stage ARG becomes ENV",
    () =>
      Effect.gen(function* () {
        const lowered = yield* planSource(
          {
            dockerfile: Dockerfile.inline`ARG V=1
FROM img:\${V}
ARG TOOL=git
RUN apt-get install -y \$TOOL`,
          },
          { args: { V: "2", TOOL: "ripgrep" } },
        );
        expect(lowered.fromImage).toBe("img:2");
        expect(lowered.steps).toContainEqual({ type: "ENV", args: ["TOOL", "ripgrep"] });
      }),
    { tags },
  );

  for (const [name, dockerfile, reason] of [
    ["multi-stage builds", "FROM a AS b\nFROM c\n", "multi-stage"],
    ["COPY --from", "FROM a\nCOPY --from=b /x /y\n", "multi-stage"],
    ["ADD from a URL", "FROM a\nADD https://example.com/x /x\n", "remote sources"],
    ["heredocs", "FROM a\nRUN <<EOF\necho hi\nEOF\n", "heredocs"],
    ["RUN --mount", "FROM a\nRUN --mount=type=cache,target=/c echo hi\n", "build mounts"],
    ["SHELL", 'FROM a\nSHELL ["/bin/bash", "-c"]\n', "not supported"],
  ] as const) {
    test.effect(
      `rejects ${name} at plan time`,
      () =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(
            planSource({ dockerfile: { content: dockerfile } as Dockerfile.InlineDockerfile }),
          );
          expect(error._tag).toBe("UnsupportedDockerfile");
          expect(error.message).toContain("E2B.Template");
          expect(error.message).toContain(reason);
        }),
      { tags },
    );
  }

  test.effect(
    "a changed COPY source changes the build hash",
    () =>
      Effect.gen(function* () {
        const { root, fs, path } = yield* makeContext({
          Dockerfile: "FROM node:22\nCOPY app.js /app/\n",
          "app.js": "one",
        });
        const hash = Effect.gen(function* () {
          const lowered = yield* planSource({
            context: root,
            dockerfile: path.join(root, "Dockerfile"),
          });
          return (yield* planTemplateBuild({ name: "t" }, lowered)).hash;
        });
        const first = yield* hash;
        expect(yield* hash).toBe(first);
        yield* fs.writeFileString(path.join(root, "app.js"), "two");
        expect(yield* hash).not.toBe(first);
      }),
    { tags },
  );

  test.effect(
    "runs a main program with Bun from /app",
    () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const lowered = yield* planSource(
          { main: path.join(import.meta.dirname, "fixtures/async-program.mjs") },
          { port: 8080 },
        );
        expect(lowered.fromImage).toBe("oven/bun:1");
        expect(lowered.startCmd).toBe("bun /app/index.mjs");
        expect(lowered.steps).toContainEqual(
          expect.objectContaining({ type: "COPY", args: ["__alchemy__/", "/app/", "", ""] }),
        );
        expect(lowered.steps).toContainEqual({ type: "ENV", args: ["PORT", "8080"] });
      }),
    { tags, timeout: 60_000 },
  );

  test.effect(
    "files and run steps follow the lowered source",
    () =>
      Effect.gen(function* () {
        const plan = yield* planTemplateBuild({
          name: "t",
          fromTemplate: "base",
          files: [{ path: "/home/user/greeting.txt", contents: "hi" }],
          run: ["cat /home/user/greeting.txt"],
        });
        expect(plan.fromImage).toBeUndefined();
        expect(plan.fromTemplate).toBe("base");
        expect(plan.steps.map((step) => step.type)).toEqual(["COPY", "RUN"]);
        expect(plan.steps[0]!.args[1]).toBe("/home/user/greeting.txt");
        expect(plan.uploads.size).toBe(1);
      }),
    { tags },
  );

  test.effect(
    "packs files into a gzipped ustar archive, long paths included",
    () =>
      Effect.gen(function* () {
        const file = (path: string, text: string) => ({
          path,
          mode: 0o644,
          contents: new TextEncoder().encode(text),
        });
        const long = `${"d/".repeat(60)}f.txt`;
        const archive = yield* tarGzip([file("a.txt", "hello"), file(long, "deep")]);
        const tar = zlib.gunzipSync(archive);
        expect(tar.subarray(257, 262).toString()).toBe("ustar");
        expect(tar.subarray(0, 5).toString()).toBe("a.txt");
        expect(tar.includes(Buffer.from(`path=${long}`))).toBe(true);
        expect(tar.length % 512).toBe(0);
      }),
    { tags },
  );
});
