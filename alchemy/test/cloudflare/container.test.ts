import path from "node:path";
import { describe } from "vitest";
import { alchemy } from "../../src/alchemy.ts";
import { Container } from "../../src/cloudflare/index.ts";
import { Worker } from "../../src/cloudflare/worker.ts";
import { destroy } from "../../src/destroy.ts";
import { Image } from "../../src/docker/image.ts";
import "../../src/test/vitest.ts";
import { BRANCH_PREFIX } from "../util.ts";

const test = alchemy.test(import.meta, {
  prefix: BRANCH_PREFIX,
});

describe("Container Resource", () => {
  test("create container", async (scope) => {
    try {
      await Worker("test-container", {
        name: "test-container",
        adopt: true,
        entrypoint: path.join(import.meta.dirname, "container-handler.ts"),
        compatibilityFlags: ["nodejs_compat"],
        compatibilityDate: "2025-06-24",
        format: "esm",
        bindings: {
          MY_CONTAINER: new Container("test-container", {
            className: "MyContainer",
            image: await Image("test-image", {
              name: "test-image",
              tag: "latest",
              build: {
                context: path.join(import.meta.dirname, "container"),
              },
            }),
            maxInstances: 1,
            name: "test-container",
          }),
        },
      });
    } finally {
      await destroy(scope);
    }
  });
});
