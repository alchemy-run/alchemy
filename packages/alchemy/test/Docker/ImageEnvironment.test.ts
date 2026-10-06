import { describe, expect, test } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as AI from "@/AI/index.ts";
import {
  buildFinalDockerfile,
  containerEnvPreamble,
  validateContainerImageProps,
  withImageLayers,
} from "@/Cloudflare/Containers/ContainerBundle.ts";
import * as Dockerfile from "@/Docker/Dockerfile.ts";
import { dedupeImageLayers, renderImageEnvironment } from "@/Docker/ImageEnvironment.ts";

const claudeLayer = {
  id: "claude-code",
  instructions: "RUN npm install -g @anthropic-ai/claude-code",
};
const codexLayer = { id: "codex", instructions: "RUN npm install -g @openai/codex" };

describe("ImageEnvironment", { tags: ["unit", "local"] }, () => {
  test("renders base → env → setup → layers → source in cache order", () => {
    const out = renderImageEnvironment({
      environment: AI.Environment({
        base: "node:22-bookworm",
        env: { CI: "1" },
        setup: Dockerfile.inline`RUN corepack enable`,
        source: AI.GitSource({ repo: "alchemy-run/alchemy", ref: "main" }),
        workdir: "/workspace",
      }),
      defaultPreamble: "FROM oven/bun:1",
      layers: [claudeLayer, codexLayer],
    });
    const order = [
      "FROM node:22-bookworm",
      'ENV CI="1"',
      "RUN corepack enable",
      "# layer: claude-code",
      "# layer: codex",
      "ADD --keep-git-dir=true https://github.com/alchemy-run/alchemy.git#main /workspace",
      'ENV ALCHEMY_WORKDIR="/workspace"',
    ].map((line) => out.indexOf(line));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  test("layers dedupe by id, first wins", () => {
    expect(
      dedupeImageLayers([claudeLayer, codexLayer, { ...claudeLayer, instructions: "RUN other" }]),
    ).toEqual([claudeLayer, codexLayer]);
  });

  test("no environment base falls back to the host default", () => {
    const out = renderImageEnvironment({
      defaultPreamble: "FROM oven/bun:1",
      layers: [codexLayer],
    });
    expect(out.startsWith("FROM oven/bun:1")).toBe(true);
    expect(out).toContain("RUN npm install -g @openai/codex");
  });

  test("full git URLs pass through untouched", () => {
    const out = renderImageEnvironment({
      environment: {
        source: AI.GitSource({ repo: "https://gitlab.com/a/b.git", keepGitDir: false }),
      },
      defaultPreamble: "FROM oven/bun:1",
    });
    expect(out).toContain("ADD https://gitlab.com/a/b.git /workspace");
  });
});

describe(
  "Cloudflare.Container environment + binding image layers",
  { tags: ["unit", "local"] },
  () => {
    test("binding layers fold into the generated container Dockerfile", async () => {
      const props = withImageLayers(
        {
          main: "file:///app/main.ts",
          environment: AI.Environment({
            base: "node:22-bookworm",
            source: AI.GitSource({ repo: "a/b" }),
          }),
        },
        [
          { data: { image: [claudeLayer] } },
          { data: { env: { X: "1" } } },
          { data: { image: [claudeLayer] } },
        ],
      );
      expect(props.imageLayers).toEqual([claudeLayer]);
      const preamble = await Effect.runPromise(containerEnvPreamble(props));
      const dockerfile = buildFinalDockerfile(preamble, "node");
      expect(dockerfile.startsWith("FROM node:22-bookworm")).toBe(true);
      expect(dockerfile.indexOf("# layer: claude-code")).toBeLessThan(
        dockerfile.indexOf("ADD --keep-git-dir=true"),
      );
      expect(dockerfile.indexOf("ADD --keep-git-dir=true")).toBeLessThan(
        dockerfile.indexOf("WORKDIR /app"),
      );
      expect(dockerfile).toContain('ENTRYPOINT ["node", "/app/index.mjs"]');
    });

    test("no environment and no layers keeps today's Dockerfile", async () => {
      const props = withImageLayers({ main: "file:///app/main.ts", image: "oven/bun:1.2" }, []);
      expect(props.imageLayers).toBeUndefined();
      expect(await Effect.runPromise(containerEnvPreamble(props))).toBe("FROM oven/bun:1.2");
    });

    test("environment is exclusive with image and requires main", async () => {
      const both = await Effect.runPromise(
        Effect.result(
          Effect.exit(
            validateContainerImageProps({
              main: "file:///app/main.ts",
              image: "oven/bun:1",
              environment: { base: "node:22" },
            }),
          ).pipe(
            Effect.flatMap((exit) =>
              exit._tag === "Failure" ? Effect.fail("died") : Effect.succeed("ok"),
            ),
          ),
        ),
      );
      expect(Result.isFailure(both)).toBe(true);
      const noMain = await Effect.runPromise(
        Effect.exit(validateContainerImageProps({ environment: { base: "node:22" } })),
      );
      expect(noMain._tag).toBe("Failure");
    });
  },
);
