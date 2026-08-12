import * as vite from "vite";
import { describe, expect, it } from "vitest";
import cloudflareVitePlugin from "../plugin.ts";

const asPlugins = (option: vite.PluginOption): Array<vite.Plugin> =>
  option as Array<vite.Plugin>;

const SERVE_ENV: vite.ConfigEnv = { command: "serve", mode: "development" };

describe("cloudflare vite plugin self-deduplication", () => {
  it("a config-file instance stands down when an injected instance is present", () => {
    const configFile = asPlugins(cloudflareVitePlugin());
    const injected = asPlugins(cloudflareVitePlugin({ injected: true }));
    const config: vite.UserConfig = { plugins: [configFile, injected] };

    for (const plugin of configFile) {
      expect(plugin.apply, `${plugin.name} has an apply guard`).toBeTypeOf(
        "function",
      );
      expect(
        (plugin.apply as (c: vite.UserConfig, e: vite.ConfigEnv) => boolean)(
          config,
          SERVE_ENV,
        ),
        `${plugin.name} stands down`,
      ).toBe(false);
    }
  });

  it("a config-file instance stays active without an injected instance", () => {
    const configFile = asPlugins(cloudflareVitePlugin());
    const config: vite.UserConfig = { plugins: [configFile] };

    for (const plugin of configFile) {
      expect(
        (plugin.apply as (c: vite.UserConfig, e: vite.ConfigEnv) => boolean)(
          config,
          SERVE_ENV,
        ),
        `${plugin.name} applies standalone`,
      ).toBe(true);
    }
  });

  it("detects the injected instance through nested plugin arrays", () => {
    const configFile = asPlugins(cloudflareVitePlugin());
    const injected = asPlugins(cloudflareVitePlugin({ injected: true }));
    // Framework configs commonly nest plugin arrays several levels deep.
    const config: vite.UserConfig = { plugins: [[configFile], [[injected]]] };

    expect(
      (
        configFile[0]!.apply as (
          c: vite.UserConfig,
          e: vite.ConfigEnv,
        ) => boolean
      )(config, SERVE_ENV),
    ).toBe(false);
  });

  it("resolves to exactly one active plugin stack when both instances are configured", async () => {
    const config = await vite.resolveConfig(
      {
        configFile: false,
        logLevel: "silent",
        // The app's own (unguarded) instance first — the shape of a config
        // file declaring `cloudflare({...})` while alchemy injects its own
        // via the inline config.
        plugins: [
          cloudflareVitePlugin(),
          cloudflareVitePlugin({ injected: true }),
        ],
      },
      "serve",
    );
    const optionsInstances = config.plugins.filter(
      (plugin) => plugin.name === "distilled-cloudflare:options",
    );
    expect(optionsInstances).toHaveLength(1);
    const devInstances = config.plugins.filter(
      (plugin) => plugin.name === "distilled-cloudflare:dev",
    );
    expect(devInstances).toHaveLength(1);
  });

  it("resolves the standalone instance when nothing is injected", async () => {
    const config = await vite.resolveConfig(
      {
        configFile: false,
        logLevel: "silent",
        plugins: [cloudflareVitePlugin()],
      },
      "serve",
    );
    expect(
      config.plugins.filter(
        (plugin) => plugin.name === "distilled-cloudflare:options",
      ),
    ).toHaveLength(1);
  });
});
