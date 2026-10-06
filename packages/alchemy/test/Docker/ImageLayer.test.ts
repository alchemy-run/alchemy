import { describe, expect, test } from "alchemy-test";
import * as Effect from "effect/Effect";
import { environmentLayers } from "@/AI/Environment.ts";
import * as AI from "@/AI/index.ts";
import {
  buildFinalDockerfile,
  containerEnvPreamble,
  withImageLayers,
} from "@/Cloudflare/Containers/ContainerBundle.ts";
import * as Dockerfile from "@/Docker/Dockerfile.ts";
import { dedupeImageLayers, renderImageLayers } from "@/Docker/ImageLayer.ts";

const claudeLayer = {
  id: "claude-code",
  instructions: "RUN npm install -g @anthropic-ai/claude-code",
};
const codexLayer = { id: "codex", instructions: "RUN npm install -g @openai/codex" };

describe("ImageLayer", { tags: ["unit", "local"] }, () => {
  test("layers dedupe by id, first wins", () => {
    expect(
      dedupeImageLayers([claudeLayer, codexLayer, { ...claudeLayer, instructions: "RUN other" }]),
    ).toEqual([claudeLayer, codexLayer]);
  });

  test("layers order setup → install → source, binding order within a stage", () => {
    const out = renderImageLayers({
      preamble: "FROM node:22-bookworm",
      layers: [
        { id: "src-a", stage: "source", instructions: "ADD a /a" },
        claudeLayer,
        { id: "setup-a", stage: "setup", instructions: "RUN apt-get install -y jq" },
        { id: "src-b", stage: "source", instructions: "ADD b /b" },
        codexLayer,
        { id: "setup-b", stage: "setup", instructions: "RUN corepack enable" },
      ],
    });
    const order = [
      "FROM node:22-bookworm",
      "RUN apt-get install -y jq",
      "RUN corepack enable",
      "# layer: claude-code",
      "# layer: codex",
      "ADD a /a",
      "ADD b /b",
    ].map((line) => out.indexOf(line));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});

describe("AI.Environment", { tags: ["unit", "local"] }, () => {
  test("contributes a setup layer and a source checkout into its own workdir", () => {
    const [setup, source] = environmentLayers("App", {
      env: { CI: "1" },
      setup: Dockerfile.inline`RUN corepack enable`,
      source: AI.GitSource({ repo: "alchemy-run/alchemy", ref: "main" }),
    });
    expect(setup).toMatchObject({ stage: "setup" });
    expect(setup!.instructions).toBe('ENV CI="1"\nRUN corepack enable');
    expect(source).toMatchObject({
      stage: "source",
      instructions:
        "ADD --keep-git-dir=true https://github.com/alchemy-run/alchemy.git#main /workspaces/App",
    });
  });

  test("full git URLs pass through; no source just creates the workdir", () => {
    expect(
      environmentLayers("B", {
        source: AI.GitSource({ repo: "https://gitlab.com/a/b.git", keepGitDir: false }),
        workdir: "/src",
      })[0]!.instructions,
    ).toBe("ADD https://gitlab.com/a/b.git /src");
    expect(environmentLayers("Empty", {})).toEqual([
      {
        id: "environment:Empty:source",
        stage: "source",
        instructions: 'RUN mkdir -p "/workspaces/Empty"',
      },
    ]);
  });

  test("returns its workdir (no host: binding is a no-op)", async () => {
    const env = await Effect.runPromise(AI.Environment("App", { workdir: "/app-src" }));
    expect(env).toEqual({ id: "App", workdir: "/app-src" });
  });
});

describe("Cloudflare.Container binding image layers", { tags: ["unit", "local"] }, () => {
  test("two environments and a harness fold into one generated Dockerfile", async () => {
    const props = withImageLayers({ main: "file:///app/main.ts", image: "node:22-bookworm" }, [
      { data: { image: environmentLayers("App", { setup: "RUN corepack enable" }) } },
      { data: { image: environmentLayers("Docs", { source: AI.GitSource({ repo: "a/docs" }) }) } },
      { data: { image: [claudeLayer] } },
      { data: { env: { X: "1" } } },
      { data: { image: [claudeLayer] } },
    ]);
    const preamble = await Effect.runPromise(containerEnvPreamble(props));
    const dockerfile = buildFinalDockerfile(preamble, "node");
    expect(dockerfile.startsWith("FROM node:22-bookworm")).toBe(true);
    const at = (s: string) => dockerfile.indexOf(s);
    expect(at("RUN corepack enable")).toBeLessThan(at("# layer: claude-code"));
    expect(dockerfile.split("# layer: claude-code").length).toBe(2);
    expect(at("# layer: claude-code")).toBeLessThan(at('RUN mkdir -p "/workspaces/App"'));
    expect(at("# layer: claude-code")).toBeLessThan(at("ADD --keep-git-dir=true"));
    expect(at("ADD --keep-git-dir=true")).toBeLessThan(at("WORKDIR /app"));
    expect(dockerfile).toContain('ENTRYPOINT ["node", "/app/index.mjs"]');
  });

  test("no layers keeps today's Dockerfile", async () => {
    const props = withImageLayers({ main: "file:///app/main.ts", image: "oven/bun:1.2" }, []);
    expect(props.imageLayers).toBeUndefined();
    expect(await Effect.runPromise(containerEnvPreamble(props))).toBe("FROM oven/bun:1.2");
  });
});
