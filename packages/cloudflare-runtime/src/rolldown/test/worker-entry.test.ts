import path from "node:path";
import type * as vite from "vite";
import { assert, describe, expect, it } from "vitest";
import { optionsPlugin } from "../plugins/options.ts";

describe("vite worker entry resolution", () => {
  const callConfig = async (userConfig: vite.UserConfig) => {
    const plugin = optionsPlugin.vite({ compatibilityDate: "2025-07-01" });
    assert(
      typeof plugin.config === "function",
      "plugin.config is not a function",
    );
    return (await plugin.config.call({ meta: {} } as never, userConfig, {
      command: "build",
      mode: "production",
    } as vite.ConfigEnv)) as vite.UserConfig;
  };

  it("resolves a relative ssr input against the vite root", async () => {
    // The user entry is resolved with no importer, so without this a relative
    // input resolves against `process.cwd()` — the wrong base when the build
    // runs outside the project root (e.g. a monorepo infra package).
    const config = await callConfig({
      root: "/project",
      environments: {
        ssr: { build: { rollupOptions: { input: "./workers/app.ts" } } },
      },
    });
    expect(config.environments?.ssr?.build?.rollupOptions?.input).toEqual({
      app: `\0distilled:worker-entry:${path.resolve("/project", "./workers/app.ts").replaceAll("\\", "/")}`,
    });
  });

  it("leaves virtual module inputs untouched", async () => {
    const config = await callConfig({
      root: "/project",
      environments: {
        ssr: {
          build: {
            rollupOptions: { input: "virtual:react-router/server-build" },
          },
        },
      },
    });
    expect(config.environments?.ssr?.build?.rollupOptions?.input).toEqual({
      "server-build":
        "\0distilled:worker-entry:virtual:react-router/server-build",
    });
  });

  // Vite's `runConfigHook` folds each plugin's result into the config the next
  // plugin sees (`conf = mergeConfig(conf, res)`), so an app that declares its
  // own server entry for the same environment ends up with both inputs in the
  // merged config. The `options` hook is what makes `main` win.
  const APP_DECLARED_SSR_INPUT: vite.UserConfig = {
    root: "/project",
    environments: {
      ssr: {
        build: {
          rollupOptions: {
            input: { "entry.server": "/src/entry.server.ts" },
          },
        },
      },
    },
  };

  const MAIN = "./src/worker.ts";

  const callOptions = async (
    environment: { name: string } | undefined,
    input: unknown,
    main: string | null = MAIN,
  ) => {
    const plugin = optionsPlugin.vite({
      ...(main === null ? {} : { main }),
      compatibilityDate: "2025-07-01",
    });
    assert(
      typeof plugin.config === "function",
      "plugin.config is not a function",
    );
    // Populates the plugin's resolved input, exactly as a real config pass does.
    await plugin.config.call({ meta: {} } as never, APP_DECLARED_SSR_INPUT, {
      command: "build",
      mode: "production",
    } as vite.ConfigEnv);
    assert(
      typeof plugin.options === "function",
      "plugin.options is not a function",
    );
    const options = { input };
    const returned = await plugin.options.call(
      {
        meta: {},
        ...(environment === undefined ? {} : { environment }),
      } as never,
      options as never,
    );
    return (returned ?? options) as { input?: unknown };
  };

  const workerEntry = `\0distilled:worker-entry:${path
    .resolve("/project", MAIN)
    .replaceAll("\\", "/")}`;

  it("merges the app's entry input with main before the build sees it", async () => {
    const { mergeConfig } = await import("vite");
    const plugin = optionsPlugin.vite({
      main: MAIN,
      compatibilityDate: "2025-07-01",
    });
    assert(
      typeof plugin.config === "function",
      "plugin.config is not a function",
    );
    const result = (await plugin.config.call(
      { meta: {} } as never,
      APP_DECLARED_SSR_INPUT,
      { command: "build", mode: "production" } as vite.ConfigEnv,
    )) as vite.UserConfig;

    // Not the fix — the reason one is needed. Two entry chunks reach the
    // bundle, and the deployed Worker is whichever the bundle lists first.
    expect(
      Object.keys(
        mergeConfig(APP_DECLARED_SSR_INPUT, result).environments?.ssr?.build
          ?.rollupOptions?.input as object,
      ).sort(),
    ).toEqual(["entry.server", "worker"]);
  });

  it("replaces an app-declared entry input with main", async () => {
    const options = await callOptions(
      { name: "ssr" },
      {
        "entry.server": "/src/entry.server.ts",
        worker: workerEntry,
      },
    );

    expect(options.input).toEqual({ worker: workerEntry });
  });

  it("leaves child environments alone", async () => {
    const input = { "entry.server": "/src/entry.server.ts" };

    const options = await callOptions({ name: "rsc" }, input);

    expect(options.input).toEqual(input);
  });

  it("leaves the input alone when no main is declared", async () => {
    const input = { "entry.server": "/src/entry.server.ts" };

    const options = await callOptions({ name: "ssr" }, input, null);

    expect(options.input).toEqual(input);
  });

  it("leaves the input alone without a resolvable environment", async () => {
    const input = { "entry.server": "/src/entry.server.ts" };

    const options = await callOptions(undefined, input);

    expect(options.input).toEqual(input);
  });
});
