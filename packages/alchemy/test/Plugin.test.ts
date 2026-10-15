import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it, layer } from "alchemy-test";
import * as Command from "effect/cli/Command";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
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
const project = (
  dependencies: Readonly<Record<string, Dependency>>,
  options: { readonly directory?: string } = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    if (options.directory !== undefined) {
      yield* fs.makeDirectory(options.directory, { recursive: true });
    }
    const root = yield* fs.makeTempDirectoryScoped({
      prefix: "alchemy-plugin-",
      directory: options.directory,
    });
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
          `export default { name: "fake", stateStore: { description: "Fake store" } };`,
        ),
      });
      const plugins = yield* Plugin.load(root);
      const names = plugins.map((plugin) => plugin.name);
      expect(names).toEqual(expect.arrayContaining(["aws", "cloudflare", "prisma", "fake"]));
      expect(plugins.find((plugin) => plugin.name === "fake")?.stateStore?.description).toBe(
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

  it.effect("a dependency's plugin replaces alchemy's own of the same name", () =>
    Effect.gen(function* () {
      const root = yield* project({
        "aws-package": pluginPackage(
          "aws-package",
          `export default { name: "aws", from: "aws-package" };`,
        ),
      });
      const aws = (yield* Plugin.load(root)).filter((plugin) => plugin.name === "aws");
      expect(aws).toHaveLength(1);
      expect((aws[0] as { from?: string }).from).toBe("aws-package");
    }).pipe(Effect.scoped),
  );

  it.effect("skips a second dependency plugin with a taken name", () =>
    Effect.gen(function* () {
      const root = yield* project({
        "first-acme": pluginPackage(
          "first-acme",
          `export default { name: "acme", from: "first" };`,
        ),
        "second-acme": pluginPackage(
          "second-acme",
          `export default { name: "acme", from: "second" };`,
        ),
      });
      const acme = (yield* Plugin.load(root)).filter((plugin) => plugin.name === "acme");
      expect(acme.map((plugin) => (plugin as { from?: string }).from)).toEqual(["first"]);
    }).pipe(Effect.scoped),
  );

  it.effect("skips a plugin that fails to load, keeping the others", () =>
    Effect.gen(function* () {
      const root = yield* project({
        "no-default": pluginPackage("no-default", `export const plugin = { name: "nope" };`),
        "fake-plugin": pluginPackage("fake-plugin", `export default { name: "fake" };`),
      });
      const names = (yield* Plugin.load(root)).map((plugin) => plugin.name);
      expect(names).toContain("fake");
      expect(names).toContain("aws");
      expect(names).not.toContain("nope");
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

  it.effect("skips a plugin whose specifier names another package", () =>
    Effect.gen(function* () {
      const root = yield* project({
        borrower: {
          manifest: { alchemy: { plugins: ["fake-plugin/Plugin"] } },
        },
      });
      const own = yield* Plugin.load(process.cwd());
      const plugins = yield* Plugin.load(root);
      expect(plugins.map((plugin) => plugin.name)).toEqual(own.map((plugin) => plugin.name));
    }).pipe(Effect.scoped),
  );

  it.effect("skips a plugin named after a backend alchemy reserves", () =>
    Effect.gen(function* () {
      const root = yield* project({
        "local-store": pluginPackage("local-store", `export default { name: "local" };`),
      });
      const names = (yield* Plugin.load(root)).map((plugin) => plugin.name);
      expect(names).not.toContain("local");
      expect(names).toContain("aws");
    }).pipe(Effect.scoped),
  );
});

/** The message of the `PluginError` a lifecycle route failed with. */
const pluginErrorMessage = (error: unknown) => {
  expect(error).toBeInstanceOf(Plugin.PluginError);
  return (error as Plugin.PluginError).message;
};

/** Run with the process in `directory`, as the CLI would run in a project. */
const inDirectory = <A, E, R>(directory: string, effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = process.cwd();
      process.chdir(directory);
      return previous;
    }),
    () => effect,
    (previous) => Effect.sync(() => process.chdir(previous)),
  );

declare global {
  var __scopedStoreState: "open" | "closed" | undefined;
}

/**
 * A plugin whose state store holds a resource its layer's finalizer closes.
 * It imports `effect` and alchemy's `State`, so it lives under this package.
 */
const scopedStorePlugin = Effect.gen(function* () {
  const path = yield* Path.Path;
  const state = path.resolve(import.meta.dirname, "../src/State/State.ts");
  return pluginPackage(
    "scoped-store",
    `import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { State } from ${JSON.stringify(state)};

const layer = Layer.effect(
  State,
  Effect.acquireRelease(
    Effect.sync(() => {
      globalThis.__scopedStoreState = "open";
      return Effect.succeed({
        listStacks: () =>
          globalThis.__scopedStoreState === "open"
            ? Effect.succeed(["open"])
            : Effect.die(new Error("the store's client is closed")),
      });
    }),
    () => Effect.sync(() => void (globalThis.__scopedStoreState = "closed")),
  ),
);

export default {
  name: "scoped-store",
  stateStore: { description: "Scoped", load: Effect.succeed({ layer: () => layer }) },
};
`,
  );
});

layer(Alchemist.layer())("Alchemist.State lifecycle", (it) => {
  it.effect(
    "a store's resources stay open until the caller's scope closes",
    () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const root = yield* project(
          { "scoped-store": yield* scopedStorePlugin },
          { directory: path.resolve(import.meta.dirname, "../.alchemy/test-plugins") },
        );
        const stacks = yield* inDirectory(
          root,
          Effect.scoped(
            Effect.flatMap(
              Alchemist.State.store({ _tag: "Plugin", backend: "scoped-store" }),
              (store) => store.listStacks(),
            ),
          ),
        );
        expect(stacks).toEqual(["open"]);
        expect(globalThis.__scopedStoreState).toBe("closed");
      }).pipe(Effect.scoped),
    // Exclusive: changes the process's working directory.
    { exclusive: true },
  );

  it.effect("rejects an unknown backend", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        Alchemist.State.bootstrap({ _tag: "Plugin", backend: "nope" }),
      );
      expect(pluginErrorMessage(error)).toBe(
        "Unknown state backend 'nope'. Available: local, configured, aws, cloudflare.",
      );
    }),
  );

  it.effect("rejects an operation the backend doesn't have", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(Alchemist.State.logs({ _tag: "Plugin", backend: "aws" }));
      expect(pluginErrorMessage(error)).toBe("State backend 'aws' does not support logs.");
    }),
  );
});

const cliPlugin = (name: string, load: Plugin.Lazy<Plugin.AnyCommand>): Plugin.Plugin =>
  Plugin.make({ name, cli: { provider: { description: `${name} commands`, load } } });

const brokenCli = cliPlugin(
  "broken",
  Effect.fail(new Plugin.PluginError({ message: "broken CLI failed to import" })),
);
const workingCli = cliPlugin(
  "working",
  Effect.succeed(Command.make("working", {}, () => Effect.void)),
);

describe("alchemy provider", () => {
  it.live("a provider whose CLI fails to load doesn't block another's", () =>
    Effect.gen(function* () {
      const command = yield* Effect.promise(() => providerCommand([brokenCli, workingCli]));
      const run = (args: ReadonlyArray<string>) =>
        Command.runWith(command, { version: "test" })(args).pipe(
          Effect.provide(NodeServices.layer),
        );
      yield* run(["working"]);
      const error = yield* Effect.flip(run(["broken"]));
      expect(String(error)).toContain("broken CLI failed to import");
    }),
  );
});

describe("Plugin contract", () => {
  it("rejects a field requiring a service no host provides", () => {
    class PrivateClient extends Context.Service<PrivateClient, { readonly id: string }>()(
      "PrivateClient",
    ) {}
    const plugin = Plugin.make({
      name: "needs-private-client",
      // @ts-expect-error PrivateClient is not a host service; the plugin must supply it.
      auth: Effect.succeed(
        Layer.effectDiscard(
          Effect.gen(function* () {
            yield* PrivateClient;
          }),
        ),
      ),
    });
    expect(plugin.name).toBe("needs-private-client");
  });
});
