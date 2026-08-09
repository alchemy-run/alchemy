import path from "node:path";
import * as vite from "vite";
import { describe, expect, it } from "vitest";
import * as DurableObjectNamespace from "../../core/bindings/DurableObjectNamespace.ts";
import cloudflareVitePlugin, {
  cloudflareViteFramework,
  type CloudflareVitePluginOptions,
} from "../plugin.ts";
import {
  getViteFrameworkContribution,
  withViteFrameworkWorker,
} from "../framework.ts";

const root = path.join(import.meta.dirname, "fixtures");

// This is the public shape Flue exposes today. Keeping the fixture structural
// makes the Alchemy seam testable without coupling this package to Flue's
// source tree or publishing a second Cloudflare runtime plugin.
const flueWorkerConfig = () => (config: object) => {
  const workerConfig = config as {
    main?: string;
    compatibility_flags?: string[];
    durable_objects?: { bindings?: unknown[] };
  };
  workerConfig.main ??= "virtual:flue/worker";
  workerConfig.compatibility_flags = [
    ...(workerConfig.compatibility_flags ?? []),
    "nodejs_compat",
  ];
  workerConfig.durable_objects = {
    bindings: [
      ...(workerConfig.durable_objects?.bindings ?? []),
      { name: "FLUE_AGENT", class_name: "FlueAgent" },
    ],
  };
};

const flue = (): vite.Plugin => ({
  name: "flue",
  config(config) {
    const plugins = Array.isArray(config.plugins) ? config.plugins : [];
    if (
      !plugins.some(
        (plugin) =>
          typeof plugin === "object" &&
          plugin !== null &&
          "name" in plugin &&
          plugin.name === "vite-plugin-cloudflare:alchemy-framework",
      )
    ) {
      throw new Error("Flue requires an Alchemy Vite framework contribution");
    }
  },
  resolveId(id) {
    return id === "virtual:flue/worker" ? id : undefined;
  },
  load(id) {
    return id === "virtual:flue/worker"
      ? "export class FlueAgent {}; export default { fetch() { return new Response('flue') } }"
      : undefined;
  },
});

describe("Alchemy Vite framework contribution", () => {
  it("builds Flue's virtual entry and combines generated and application Durable Objects through one runtime plugin", async () => {
    const options: CloudflareVitePluginOptions = {
      worker: {
        name: "framework-fixture",
        bindings: [
          DurableObjectNamespace.local({
            binding: "APP_DO",
            className: "ApplicationDurableObject",
          }),
        ],
        durableObjectNamespaces: [
          { className: "ApplicationDurableObject", sql: true },
        ],
      },
    };
    const runtime = cloudflareVitePlugin(options);
    const builder = await vite.createBuilder(
      {
        configFile: false,
        root,
        logLevel: "silent",
        build: { write: false },
        plugins: [flue(), cloudflareViteFramework(flueWorkerConfig()), runtime],
      },
      null,
    );
    await builder.buildApp();

    expect(options.main).toBe("virtual:flue/worker");
    expect(getViteFrameworkContribution(options)).toEqual({
      main: "virtual:flue/worker",
      compatibilityFlags: ["nodejs_compat"],
      durableObjects: [{ binding: "FLUE_AGENT", className: "FlueAgent" }],
    });
    expect(withViteFrameworkWorker(options)?.durableObjectNamespaces).toEqual([
      { className: "ApplicationDurableObject", sql: true },
      { className: "FlueAgent", sql: true },
    ]);
    // `cloudflareViteFramework()` only presents the conventional name for
    // Flue's config detection; `cloudflareVitePlugin()` is invoked once.
    expect(
      builder.config.plugins.filter(
        (plugin) => plugin.name === "vite-plugin-cloudflare:alchemy-framework",
      ),
    ).toHaveLength(1);
    expect(
      builder.config.plugins.filter(
        (plugin) => plugin.name === "distilled-cloudflare:options",
      ),
    ).toHaveLength(1);
  });
});
