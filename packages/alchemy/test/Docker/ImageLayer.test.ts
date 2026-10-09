import { describe, expect, test } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  buildFinalDockerfile,
  containerEnvPreamble,
  withImageLayers,
} from "@/Cloudflare/Containers/ContainerBundle.ts";
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

describe("Cloudflare.Container binding image layers", { tags: ["unit", "local"] }, () => {
  test("setup, harness and source layers fold into one generated Dockerfile", async () => {
    const props = withImageLayers({ main: "file:///app/main.ts", image: "node:22-bookworm" }, [
      {
        data: {
          image: [
            { id: "src-app", stage: "source", instructions: "COPY mounts/a/ /workspace/app/" },
          ],
        },
      },
      { data: { image: [{ id: "setup", stage: "setup", instructions: "RUN corepack enable" }] } },
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
    expect(at("# layer: claude-code")).toBeLessThan(at("COPY mounts/a/ /workspace/app/"));
    expect(at("COPY mounts/a/")).toBeLessThan(at("WORKDIR /app"));
    expect(dockerfile).toContain('ENTRYPOINT ["node", "/app/index.mjs"]');
  });

  test("no layers keeps today's Dockerfile", async () => {
    const props = withImageLayers({ main: "file:///app/main.ts", image: "oven/bun:1.2" }, []);
    expect(props.imageLayers).toBeUndefined();
    expect(await Effect.runPromise(containerEnvPreamble(props))).toBe("FROM oven/bun:1.2");
  });
});
