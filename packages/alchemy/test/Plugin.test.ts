import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it, layer } from "alchemy-test";
import * as Command from "effect/cli/Command";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Alchemist from "@/Alchemist/index.ts";
import { providerCommand } from "@/Cli/commands/provider.ts";
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
  it.effect("resolves a dependency's plugin with import conditions", () =>
    Effect.gen(function* () {
      const root = yield* project({
        "import-only": {
          manifest: {
            exports: { "./Plugin": { import: "./Plugin.js" } },
            alchemy: { plugins: ["import-only/Plugin"] },
          },
          files: { "Plugin.js": `export default { name: "import-only" };` },
        },
        dual: {
          manifest: {
            exports: { "./Plugin": { require: "./Plugin.cjs", import: "./Plugin.js" } },
            alchemy: { plugins: ["dual/Plugin"] },
          },
          files: {
            "Plugin.js": `export default { name: "dual-esm" };`,
            "Plugin.cjs": `module.exports = { default: { name: "dual-cjs" } };`,
          },
        },
      });
      const names = (yield* Plugin.load(root)).map((plugin) => plugin.name);
      expect(names).toContain("import-only");
      expect(names).toContain("dual-esm");
      expect(names).not.toContain("dual-cjs");
    }).pipe(Effect.scoped),
  );

  it.effect("fails when a plugin specifier names another package", () =>
    Effect.gen(function* () {
      const root = yield* project({
        borrower: {
          manifest: { alchemy: { plugins: ["fake-plugin/Plugin"] } },
        },
      });
      const error = yield* Effect.flip(Plugin.load(root));
      expect(error.message).toContain("must name that package (borrower)");
    }).pipe(Effect.scoped),
  );

  it.effect("fails when a plugin registers a state store another plugin has", () =>
    Effect.gen(function* () {
      const root = yield* project({
        "second-s3": pluginPackage(
          "second-s3",
          `export default { name: "second-s3", stateStores: { aws: { description: "S3 again" } } };`,
        ),
      });
      const error = yield* Effect.flip(Plugin.load(root));
      expect(error.message).toBe(
        "Plugin second-s3 registers state store 'aws', which plugin aws already registers",
      );
    }).pipe(Effect.scoped),
  );

  it.effect("fails when a plugin registers a reserved state store name", () =>
    Effect.gen(function* () {
      const root = yield* project({
        "local-store": pluginPackage(
          "local-store",
          `export default { name: "local-store", stateStores: { local: { description: "Mine" } } };`,
        ),
      });
      const error = yield* Effect.flip(Plugin.load(root));
      expect(error.message).toBe(
        "Plugin local-store registers state store 'local', which alchemy reserves",
      );
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

  it.effect("rejects a lifecycle operation on alchemy's own backends", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(Alchemist.State.bootstrap({ backend: "local" }));
      expect(pluginErrorMessage(error)).toBe("State backend 'local' does not support bootstrap.");
    }),
  );

  it.effect("rejects an operation the backend doesn't have", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(Alchemist.State.logs({ backend: "aws" }));
      expect(pluginErrorMessage(error)).toBe("State backend 'aws' does not support logs.");
    }),
  );
});

/** Run with `process.argv` set, as the CLI would be invoked. */
const withArgv = <A, E, R>(argv: ReadonlyArray<string>, effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = process.argv;
      process.argv = [previous[0]!, previous[1]!, ...argv];
      return previous;
    }),
    () => effect,
    (previous) => Effect.sync(() => void (process.argv = previous)),
  );

const cliPlugin = (name: string, load: Plugin.Lazy<Plugin.AnyCommand>): Plugin.Plugin =>
  Plugin.make({ name, cli: { provider: { name, description: `${name} commands`, load } } });

const brokenCli = cliPlugin(
  "broken",
  Effect.fail(new Plugin.PluginError({ message: "broken CLI failed to import" })),
);
const workingCli = cliPlugin("working", Effect.succeed(Command.make("working")));

describe("alchemy provider", () => {
  it.live(
    "a provider whose CLI fails to load doesn't block another's",
    () =>
      withArgv(
        ["provider", "working", "--help"],
        Effect.promise(() => providerCommand([brokenCli, workingCli])),
      ).pipe(Effect.map((command) => expect(command.name).toBe("provider"))),
    { exclusive: true },
  );

  it.live(
    "a provider whose CLI fails to load fails with its error when run",
    () =>
      withArgv(
        ["provider", "broken"],
        Effect.promise(() => providerCommand([brokenCli, workingCli])).pipe(
          Effect.flatMap((command) =>
            Effect.flip(
              Command.runWith(command, { version: "test" })(["broken"]).pipe(
                Effect.provide(NodeServices.layer),
              ),
            ),
          ),
          Effect.map((error) => expect(String(error)).toContain("broken CLI failed to import")),
        ),
      ),
    { exclusive: true },
  );
});
