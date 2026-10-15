import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, layer } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Alchemist from "@/Alchemist/index.ts";
import * as Plugin from "@/Plugin.ts";

interface Dependency {
  /** `package.json` of the dependency; omit to leave it uninstalled. */
  readonly manifest?: object;
  /** Files beside it, by name. */
  readonly files?: Readonly<Record<string, string>>;
}

/**
 * A project in a temp directory, outside the repo, so a dependency's plugin
 * only loads when it's resolved from the dependency itself.
 */
const project = (dependencies: Readonly<Record<string, Dependency>>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-plugin-" });
    yield* fs.writeFileString(
      path.join(root, "package.json"),
      JSON.stringify({
        name: "project",
        dependencies: Object.fromEntries(Object.keys(dependencies).map((name) => [name, "*"])),
      }),
    );
    for (const [name, dependency] of Object.entries(dependencies)) {
      if (dependency.manifest === undefined) continue;
      const directory = path.join(root, "node_modules", name);
      yield* fs.makeDirectory(directory, { recursive: true });
      yield* fs.writeFileString(
        path.join(directory, "package.json"),
        JSON.stringify({ name, type: "module", ...dependency.manifest }),
      );
      for (const [file, contents] of Object.entries(dependency.files ?? {})) {
        yield* fs.writeFileString(path.join(directory, file), contents);
      }
    }
    return root;
  });

const pluginPackage = (name: string, plugin: string): Dependency => ({
  manifest: {
    exports: { "./Plugin": "./Plugin.js" },
    alchemy: { plugins: [`${name}/Plugin`] },
  },
  files: { "Plugin.js": plugin },
});

layer(NodeServices.layer)("Plugin.load", (it) => {
  it.effect("loads alchemy's own plugins and a dependency's", () =>
    Effect.gen(function* () {
      const root = yield* project({
        "fake-plugin": pluginPackage(
          "fake-plugin",
          `export default { name: "fake", stateStores: { fake: { description: "Fake store" } } };`,
        ),
      });
      const plugins = yield* Plugin.load(root);
      const names = plugins.map((plugin) => plugin.name);
      expect(names).toEqual(expect.arrayContaining(["aws", "cloudflare", "prisma", "fake"]));
      expect(plugins.find((plugin) => plugin.name === "fake")?.stateStores?.fake?.description).toBe(
        "Fake store",
      );
    }).pipe(Effect.scoped),
  );

  it.effect("skips dependencies without plugins and ones not installed", () =>
    Effect.gen(function* () {
      const root = yield* project({
        "plain-package": { manifest: { exports: { ".": "./index.js" } } },
        "not-installed": {},
      });
      const own = yield* Plugin.load(process.cwd());
      const plugins = yield* Plugin.load(root);
      expect(plugins.map((plugin) => plugin.name)).toEqual(own.map((plugin) => plugin.name));
    }).pipe(Effect.scoped),
  );

  it.effect("fails when two plugins share a name", () =>
    Effect.gen(function* () {
      const root = yield* project({
        "second-aws": pluginPackage("second-aws", `export default { name: "aws" };`),
      });
      const error = yield* Effect.flip(Plugin.load(root));
      expect(error.message).toBe("Two plugins are named aws");
    }).pipe(Effect.scoped),
  );

  it.effect("fails when a plugin module has no default-exported plugin", () =>
    Effect.gen(function* () {
      const root = yield* project({
        "no-default": pluginPackage("no-default", `export const plugin = { name: "nope" };`),
      });
      const error = yield* Effect.flip(Plugin.load(root));
      expect(error.message).toBe("Plugin no-default/Plugin has no default-exported plugin");
    }).pipe(Effect.scoped),
  );
});

/** The message of the `PluginError` a lifecycle route failed with. */
const pluginErrorMessage = (error: { readonly _tag: string }) => {
  expect(error).toBeInstanceOf(Plugin.PluginError);
  return (error as Plugin.PluginError).message;
};

layer(Alchemist.layer())("Alchemist.State lifecycle", (it) => {
  it.effect("rejects an unknown backend", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(Alchemist.State.bootstrap({ backend: "nope" }));
      expect(pluginErrorMessage(error)).toBe(
        "Unknown state backend 'nope'. Available: local, configured, aws, cloudflare.",
      );
    }),
  );

  it.effect("rejects an operation the backend doesn't have", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(Alchemist.State.logs({ backend: "aws" }));
      expect(pluginErrorMessage(error)).toBe("State backend 'aws' does not support logs.");
    }),
  );

  it.effect("rejects a name for a backend with only the default store", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        Alchemist.State.bootstrap({ backend: "cloudflare", name: "second-store" }),
      );
      expect(pluginErrorMessage(error)).toBe(
        "State backend 'cloudflare' has only the default store; it does not take a name.",
      );
    }),
  );
});
