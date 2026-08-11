import path from "node:path";
import * as vite from "vite";
import { describe, expect, it } from "vitest";
import * as DurableObjectNamespace from "../../core/bindings/DurableObjectNamespace.ts";
import cloudflareVitePlugin, {
  cloudflareViteFramework,
  type CloudflareVitePluginOptions,
} from "../plugin.ts";
import {
  applyViteFrameworkContributions,
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
      ? `export { ApplicationDurableObject } from ${JSON.stringify(path.join(root, "worker-entry.ts"))};
         export { default } from ${JSON.stringify(path.join(root, "worker-entry.ts"))};
         export class FlueAgent {}`
      : undefined;
  },
});

describe("Alchemy Vite framework contribution", () => {
  it("builds Flue's virtual entry and combines generated and application Durable Objects through one runtime plugin", async () => {
    const options: CloudflareVitePluginOptions = {
      compatibilityFlags: ["nodejs_compat"],
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
    expect(options.compatibilityFlags).toEqual(["nodejs_compat"]);
    expect(withViteFrameworkWorker(options)?.durableObjectNamespaces).toEqual([
      { className: "ApplicationDurableObject", sql: true },
      { className: "FlueAgent", sql: true },
    ]);
    expect(withViteFrameworkWorker(options)?.bindings).toHaveLength(2);
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

  it("rejects distinct framework-contributed Worker entries", () => {
    const options: CloudflareVitePluginOptions = {};
    const contribution = (main: string): vite.Plugin => ({
      name: `framework-${main}`,
      api: { alchemyCloudflareViteFramework: () => ({ main }) },
    });

    expect(() =>
      applyViteFrameworkContributions(options, {
        plugins: [
          contribution("virtual:first"),
          contribution("virtual:second"),
        ],
      }),
    ).toThrowError(
      'Framework Vite contributions disagree about the Worker entry: "virtual:first", "virtual:second".',
    );
  });

  it("rejects an explicit Alchemy entry that differs from the framework entry", () => {
    const options: CloudflareVitePluginOptions = {
      main: path.join(root, "worker-entry.ts"),
    };

    expect(() =>
      applyViteFrameworkContributions(options, {
        plugins: [
          {
            name: "framework",
            api: {
              alchemyCloudflareViteFramework: () => ({
                main: "virtual:framework/worker",
              }),
            },
          } as vite.Plugin,
        ],
      }),
    ).toThrowError(
      /Alchemy's Vite Worker entry .* conflicts with framework-contributed entry/,
    );
  });

  it("replaces a prior framework entry when Vite reloads its config", () => {
    const options: CloudflareVitePluginOptions = {
      compatibilityFlags: ["application_flag"],
    };
    let main = "virtual:framework/first";
    let compatibilityFlags = ["framework_first"];
    const framework: vite.Plugin = {
      name: "framework",
      api: {
        alchemyCloudflareViteFramework: () => ({ main, compatibilityFlags }),
      },
    } as vite.Plugin;

    applyViteFrameworkContributions(options, { plugins: [framework] });
    expect(options.main).toBe("virtual:framework/first");
    expect(options.compatibilityFlags).toEqual([
      "application_flag",
      "framework_first",
    ]);

    main = "virtual:framework/second";
    compatibilityFlags = ["framework_second"];
    applyViteFrameworkContributions(options, { plugins: [framework] });
    expect(options.main).toBe("virtual:framework/second");
    expect(options.compatibilityFlags).toEqual([
      "application_flag",
      "framework_second",
    ]);
  });

  it("keeps application-owned local Durable Objects authoritative", () => {
    const options: CloudflareVitePluginOptions = {
      worker: {
        name: "worker",
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
    const contribution = (binding: string, className: string): vite.Plugin =>
      ({
        name: "framework",
        api: {
          alchemyCloudflareViteFramework: () => ({
            durableObjects: [{ binding, className }],
          }),
        },
      }) as vite.Plugin;

    applyViteFrameworkContributions(options, {
      plugins: [contribution("APP_DO", "ApplicationDurableObject")],
    });
    expect(withViteFrameworkWorker(options)?.bindings).toHaveLength(1);
    expect(
      withViteFrameworkWorker(options)?.durableObjectNamespaces,
    ).toHaveLength(1);

    applyViteFrameworkContributions(options, {
      plugins: [contribution("APP_ALIAS", "ApplicationDurableObject")],
    });
    expect(withViteFrameworkWorker(options)?.bindings).toHaveLength(2);
    expect(
      withViteFrameworkWorker(options)?.durableObjectNamespaces,
    ).toHaveLength(1);

    applyViteFrameworkContributions(options, {
      plugins: [contribution("APP_DO", "ConflictingDurableObject")],
    });
    expect(() => withViteFrameworkWorker(options)).toThrowError(
      /conflicts with the application Worker/,
    );
  });
});
