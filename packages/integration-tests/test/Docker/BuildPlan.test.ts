import * as BuildPlan from "@alchemy.run/docker/BuildPlan";
import * as Dockerfile from "@alchemy.run/docker/Dockerfile";
import * as DockerfileParser from "@alchemy.run/docker/DockerfileParser";
import { expect, layer } from "@alchemy.run/test";
import { BunServices } from "@effect/platform-bun";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

const tags = ["unit", "provider:docker", "local"];

const docker: BuildPlan.Capabilities = { target: "Docker" };

const e2b: BuildPlan.Capabilities = {
  target: "E2B.Template",
  multiStage: false,
  instructions: { HEALTHCHECK: "unsupported", EXPOSE: "ignored" },
};

const makeContext = Effect.fn(function* (files: Record<string, string>) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-build-plan-" });
  for (const [name, content] of Object.entries(files)) {
    yield* fs.makeDirectory(path.dirname(path.join(root, name)), { recursive: true });
    yield* fs.writeFileString(path.join(root, name), content);
  }
  return { root, fs, path };
});

layer(BunServices.layer)("DockerfileParser", (test) => {
  test.effect(
    "parses continuations, comments inside them, and both command forms",
    () =>
      Effect.gen(function* () {
        const parsed = yield* DockerfileParser.parse(
          [
            "# syntax=docker/dockerfile:1",
            "ARG NODE=22",
            "FROM --platform=linux/amd64 node:${NODE} AS base",
            "RUN apt-get update \\",
            "  # a comment inside the continuation",
            "  && apt-get install -y git",
            'CMD ["bun", "index.mjs"]',
            "ENTRYPOINT bun run start",
          ].join("\n"),
        );
        expect(parsed.directives).toEqual({ syntax: "docker/dockerfile:1" });
        expect(parsed.globalArgs[0]!.vars).toEqual([["NODE", "22"]]);
        const stage = parsed.stages[0]!;
        expect(stage.image).toBe("node:${NODE}");
        expect(stage.name).toBe("base");
        expect(stage.flags).toEqual([{ name: "platform", value: "linux/amd64" }]);
        const [run, cmd, entrypoint] = stage.instructions;
        expect(run).toMatchObject({
          _tag: "RUN",
          line: 4,
          command: { form: "shell", script: "apt-get update   && apt-get install -y git" },
        });
        expect(cmd).toMatchObject({
          _tag: "CMD",
          line: 7,
          command: { form: "exec", argv: ["bun", "index.mjs"] },
        });
        expect(entrypoint).toMatchObject({ command: { form: "shell", script: "bun run start" } });
      }),
    { tags },
  );

  test.effect(
    "parses heredocs, ENV forms, multi-arg ARG, COPY flags and the backtick escape",
    () =>
      Effect.gen(function* () {
        const parsed = yield* DockerfileParser.parse(
          [
            "# escape=`",
            "FROM alpine",
            "RUN <<EOF",
            "echo one",
            "echo two",
            "EOF",
            "COPY --chmod=755 <<-'SCRIPT' /run.sh",
            "\t#!/bin/sh",
            "\techo hi",
            "SCRIPT",
            'ENV A=1 B="two words"',
            "ENV LEGACY some value",
            "ARG X=1 Y",
            "COPY --from=build --chown=app:app /out `",
            "  /app/",
          ].join("\n"),
        );
        const [run, copyScript, env, legacy, arg, copyFrom] = parsed.stages[0]!.instructions;
        expect(run).toMatchObject({
          heredocs: [{ name: "EOF", content: "echo one\necho two\n", stripTabs: false }],
        });
        expect(copyScript).toMatchObject({
          _tag: "COPY",
          sources: ["<<-SCRIPT"],
          destination: "/run.sh",
          flags: [{ name: "chmod", value: "755" }],
          heredocs: [
            { name: "SCRIPT", content: "#!/bin/sh\necho hi\n", stripTabs: true, quoted: true },
          ],
        });
        expect(env).toMatchObject({
          vars: [
            ["A", "1"],
            ["B", "two words"],
          ],
        });
        expect(legacy).toMatchObject({ vars: [["LEGACY", "some value"]] });
        expect(arg).toMatchObject({
          vars: [
            ["X", "1"],
            ["Y", undefined],
          ],
        });
        expect(copyFrom).toMatchObject({
          sources: ["/out"],
          destination: "/app/",
          flags: [
            { name: "from", value: "build" },
            { name: "chown", value: "app:app" },
          ],
        });
      }),
    { tags },
  );

  test.effect(
    "renders what it parsed",
    () =>
      Effect.gen(function* () {
        const text = "FROM alpine AS a\nRUN echo a \\\n  && echo b\nFROM a\nCOPY x /x\n";
        const parsed = yield* DockerfileParser.parse(text);
        expect(DockerfileParser.render(parsed)).toBe(text);
      }),
    { tags },
  );

  test.effect(
    "reports syntax errors with their line",
    () =>
      Effect.gen(function* () {
        const unknown = yield* Effect.flip(DockerfileParser.parse("FROM alpine\nFETCH x\n"));
        expect(unknown).toMatchObject({ _tag: "DockerfileSyntaxError", line: 2 });
        const early = yield* Effect.flip(DockerfileParser.parse("RUN echo\nFROM alpine\n"));
        expect(early).toMatchObject({ line: 1, message: "RUN before the first FROM" });
        const heredoc = yield* Effect.flip(
          DockerfileParser.parse("FROM alpine\nRUN <<EOF\necho\n"),
        );
        expect(heredoc).toMatchObject({ line: 2, message: "unterminated heredoc <<EOF" });
      }),
    { tags },
  );
});

layer(BunServices.layer)("BuildPlan", (test) => {
  test.effect(
    "an image ref plans to a bare FROM",
    () =>
      Effect.gen(function* () {
        const plan = yield* BuildPlan.plan({ image: "python:3.12-slim" }, { capabilities: docker });
        expect(plan.base).toBe("python:3.12-slim");
        expect(plan.instructions).toEqual([]);
        expect(plan.files).toEqual([]);
        expect(BuildPlan.startCommand(plan)).toBeUndefined();
      }),
    { tags },
  );

  test.effect(
    "an inline Dockerfile that copies from a context is rejected",
    () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          BuildPlan.plan(
            {
              dockerfile: Dockerfile.inline`FROM alpine
COPY src /src`,
            },
            { capabilities: docker },
          ),
        );
        expect(error._tag).toBe("BuildPlanError");
      }),
    { tags },
  );

  test.effect(
    "collects only the context files COPY reaches, minus .dockerignore",
    () =>
      Effect.gen(function* () {
        const { root } = yield* makeContext({
          Dockerfile: "FROM node:22\nCOPY src/ /app/src/\nCOPY *.json /app/\nRUN npm ci\n",
          ".dockerignore": "src/**/*.test.ts\n",
          "package.json": "{}",
          "tsconfig.json": "{}",
          "README.md": "not copied",
          "src/index.ts": "export {}",
          "src/index.test.ts": "ignored",
          "node_modules/left-pad/index.js": "not reached",
        });
        const plan = yield* BuildPlan.plan({ context: root }, { capabilities: docker });
        expect(plan.files.map((file) => file.path)).toEqual([
          "package.json",
          "src/index.ts",
          "tsconfig.json",
        ]);
        const [copySrc, copyJson] = plan.instructions;
        expect(
          BuildPlan.filesFor(plan, copySrc as DockerfileParser.CopyInstruction).map(
            (file) => file.path,
          ),
        ).toEqual(["src/index.ts"]);
        expect(
          BuildPlan.filesFor(plan, copyJson as DockerfileParser.CopyInstruction).map(
            (file) => file.path,
          ),
        ).toEqual(["package.json", "tsconfig.json"]);
        const bytes = yield* BuildPlan.readContextFile(plan.files[1]!);
        expect(new TextDecoder().decode(bytes)).toBe("export {}");
      }),
    { tags },
  );

  test.effect(
    "the hash is stable and changes with a copied file, but not an unreachable one",
    () =>
      Effect.gen(function* () {
        const { root, fs, path } = yield* makeContext({
          Dockerfile: "FROM node:22\nCOPY src /src\n",
          "src/a.ts": "a",
          "docs/b.md": "b",
        });
        const first = yield* BuildPlan.plan({ context: root }, { capabilities: docker });
        const again = yield* BuildPlan.plan({ context: root }, { capabilities: docker });
        expect(again.hash).toBe(first.hash);

        yield* fs.writeFileString(path.join(root, "docs", "b.md"), "changed");
        expect((yield* BuildPlan.plan({ context: root }, { capabilities: docker })).hash).toBe(
          first.hash,
        );

        yield* fs.writeFileString(path.join(root, "src", "a.ts"), "changed");
        expect((yield* BuildPlan.plan({ context: root }, { capabilities: docker })).hash).not.toBe(
          first.hash,
        );
      }),
    { tags },
  );

  test.effect(
    "capabilities reject at plan time with every offending line",
    () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          BuildPlan.plan(
            {
              dockerfile: Dockerfile.inline`FROM node:22 AS build
RUN npm run build
FROM node:22-slim
COPY --from=build /app/dist /app
HEALTHCHECK CMD curl -f http://localhost/
EXPOSE 3000`,
            },
            { capabilities: e2b },
          ),
        );
        expect(error._tag).toBe("UnsupportedDockerfile");
        if (error._tag !== "UnsupportedDockerfile") return;
        expect(error.violations).toEqual([
          { line: 3, instruction: "FROM", reason: "multi-stage builds are not supported" },
          { line: 4, instruction: "COPY --from", reason: "multi-stage builds are not supported" },
          { line: 5, instruction: "HEALTHCHECK", reason: "not supported" },
        ]);
        expect(error.message).toContain("line 4: COPY --from");
      }),
    { tags },
  );

  test.effect(
    "ignored instructions become warnings, and platforms are checked",
    () =>
      Effect.gen(function* () {
        const plan = yield* BuildPlan.plan(
          {
            dockerfile: Dockerfile.inline`FROM node:22
EXPOSE 3000
CMD ["node", "server.js"]`,
          },
          { capabilities: e2b },
        );
        expect(plan.warnings).toEqual(["E2B.Template ignores EXPOSE (line 2)"]);
        expect(BuildPlan.startCommand(plan)).toEqual(["node", "server.js"]);

        const error = yield* Effect.flip(
          BuildPlan.plan(
            { image: "node:22" },
            {
              capabilities: { target: "Daytona.Snapshot", platforms: ["linux/amd64"] },
              platform: "linux/arm64",
            },
          ),
        );
        expect(error).toMatchObject({
          _tag: "UnsupportedDockerfile",
          violations: [{ instruction: "platform" }],
        });
      }),
    { tags },
  );

  test.effect(
    "startCommand follows Docker's ENTRYPOINT and CMD rules",
    () =>
      Effect.gen(function* () {
        const exec = yield* BuildPlan.plan(
          {
            dockerfile: Dockerfile.inline`FROM node:22
ENTRYPOINT ["node"]
CMD ["server.js"]`,
          },
          { capabilities: docker },
        );
        expect(BuildPlan.startCommand(exec)).toEqual(["node", "server.js"]);
        const shell = yield* BuildPlan.plan(
          {
            dockerfile: Dockerfile.inline`FROM node:22
ENTRYPOINT node server.js
CMD ["ignored"]`,
          },
          { capabilities: docker },
        );
        expect(BuildPlan.startCommand(shell)).toEqual(["/bin/sh", "-c", "node server.js"]);
      }),
    { tags },
  );

  test.effect(
    "a bundled main becomes a generated layer on the environment",
    () =>
      Effect.gen(function* () {
        const { root, path } = yield* makeContext({
          "package.json": JSON.stringify({ name: "fixture", type: "module" }),
          "main.ts": "export default { hello: 'world' };\n",
        });
        const plan = yield* BuildPlan.plan(
          {
            main: path.join(root, "main.ts"),
            dockerfile: Dockerfile.inline`FROM oven/bun:1
RUN apt-get update && apt-get install -y git`,
          },
          { capabilities: e2b, port: 3000 },
        );
        expect(plan.base).toBe("oven/bun:1");
        expect(
          plan.instructions.map((instruction) => [instruction._tag, instruction.line]),
        ).toEqual([
          ["RUN", 2],
          ["WORKDIR", 0],
          ["COPY", 0],
          ["ENV", 0],
          ["ENTRYPOINT", 0],
        ]);
        expect(plan.files.map((file) => file.path)).toContain(`${BuildPlan.BUNDLE_DIR}/index.mjs`);
        const copy = plan.instructions[2] as DockerfileParser.CopyInstruction;
        expect(BuildPlan.filesFor(plan, copy).map((file) => file.path)).toContain(
          `${BuildPlan.BUNDLE_DIR}/index.mjs`,
        );
        expect(BuildPlan.startCommand(plan)).toEqual(["bun", "/app/index.mjs"]);
        expect(BuildPlan.render(plan)).toContain(`COPY ${BuildPlan.BUNDLE_DIR}/ /app/`);
      }),
    { tags },
  );
});
