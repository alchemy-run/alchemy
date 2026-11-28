import { expect, layer } from "@alchemy.run/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import type * as rolldown from "rolldown";
import * as Bundle from "@/Bundle/Bundle";

/** Where a package manager keeps its one copy of the fixture's dependency. */
const storeDirectory = {
  pnpm: "node_modules/.pnpm/fixture-dependency@1.0.0/node_modules/fixture-dependency",
  bun: "node_modules/.bun/fixture-dependency@1.0.0/node_modules/fixture-dependency",
} as const;

interface Checkout {
  /** The checkout's directory, relative to the temporary root. */
  readonly directory: string;
  /** The package manager's store directory, relative to the temporary root. */
  readonly store: string;
  readonly manager: keyof typeof storeDirectory;
  /** A comment in a source: it changes the source and nothing of the code built from it. */
  readonly note?: string;
}

/**
 * Creates a checkout as a CI job has one: a package whose entry imports a
 * source outside the package and a dependency. The package manager keeps the
 * dependency in a store directory of its own and links it into the package's
 * `node_modules`. The entry also imports a module that is not a file, which a
 * plugin provides (see {@link inputOf}).
 */
const makeCheckout = (root: string, checkout: Checkout) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const write = (file: string, text: string) =>
      Effect.andThen(
        fs.makeDirectory(path.dirname(file), { recursive: true }),
        fs.writeFileString(file, text),
      );
    const app = path.join(root, checkout.directory, "app");
    const entry = path.join(app, "src/entry.ts");
    yield* write(
      path.join(app, "package.json"),
      JSON.stringify({ name: "fixture-app", type: "module" }),
    );
    yield* write(
      entry,
      [
        'import { greeting } from "../../shared/greeting.ts";',
        'import { decorate } from "fixture-dependency";',
        'import { suffix } from "virtual:suffix";',
        "export default { fetch: () => new Response(decorate(greeting) + suffix()) };",
        "",
      ].join("\n"),
    );
    yield* write(
      path.join(root, checkout.directory, "shared/greeting.ts"),
      `// ${checkout.note ?? "first"}\nexport const greeting = "hello";\n`,
    );
    const dependency = path.join(root, checkout.store, storeDirectory[checkout.manager]);
    yield* write(
      path.join(dependency, "package.json"),
      JSON.stringify({
        name: "fixture-dependency",
        version: "1.0.0",
        type: "module",
        main: "index.js",
      }),
    );
    // A body the bundler cannot fold into a constant, so the file stays a
    // source of the bundle.
    yield* write(
      path.join(dependency, "index.js"),
      "export const decorate = (text) => [...text].reverse().join(String(Date.now() % 2));\n",
    );
    yield* fs.makeDirectory(path.join(app, "node_modules"), { recursive: true });
    yield* fs.symlink(dependency, path.join(app, "node_modules/fixture-dependency"));
    return { app, entry };
  });

/**
 * The input options of a checkout's bundle. The plugin provides `virtual:suffix`
 * under its own name, as plugins such as rolldown's `esmExternalRequirePlugin`
 * do for the modules they add (`builtin:…`).
 */
const inputOf = (checkout: { readonly app: string; readonly entry: string }) =>
  ({
    input: checkout.entry,
    cwd: checkout.app,
    plugins: [
      {
        name: "fixture:virtual",
        resolveId: (id) => (id === "virtual:suffix" ? id : null),
        load: (id) =>
          id === "virtual:suffix" ? "export const suffix = () => String(Date.now() % 3);" : null,
      },
    ],
  }) satisfies rolldown.InputOptions;

/**
 * Builds a checkout minified, as a Worker bundle is. Unminified code also
 * carries rolldown's module path comments, which no output option controls.
 */
const build = (root: string, checkout: Checkout, output?: rolldown.OutputOptions) =>
  Effect.gen(function* () {
    const input = inputOf(yield* makeCheckout(root, checkout));
    return yield* Bundle.build(input, { sourcemap: "hidden", minify: true, ...output });
  });

const text = (file: Bundle.BundleFile) =>
  typeof file.content === "string" ? file.content : new TextDecoder().decode(file.content);

const contents = (output: Bundle.BundleOutput) =>
  Object.fromEntries(output.files.map((file) => [file.path, text(file)]));

const sources = (output: Bundle.BundleOutput): string[] => {
  const map = output.files.find((file) => file.path.endsWith(".map"));
  if (map === undefined) throw new Error("the bundle has no source map");
  return [...JSON.parse(text(map)).sources].sort();
};

/** What a map names, `up` directories below the bundle `cwd`. */
const stableSources = (manager: keyof typeof storeDirectory, up: string) =>
  [
    `${up}../shared/greeting.ts`,
    `${up}${storeDirectory[manager]}/index.js`,
    `${up}src/entry.ts`,
    "virtual:suffix",
  ].sort();

layer(NodeServices.layer)("Bundle source map paths", (it) => {
  for (const manager of ["pnpm", "bun"] as const) {
    it.effect(
      `build gives the same bundle wherever the checkout and the ${manager} store sit`,
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-bundle-source-map-" });

          // Two CI jobs at one commit: another directory, another depth, and
          // a freshly named store.
          const first = yield* build(root, {
            directory: "one/checkout",
            store: "one/store/aaaaaaaa",
            manager,
          });
          const second = yield* build(root, {
            directory: "two/runner/work/checkout",
            store: "two/cache/store/bbbbbbbb",
            manager,
          });

          // In memory the map sits in rolldown's default `dist`, one below `cwd`.
          expect(sources(first)).toEqual(stableSources(manager, "../"));
          expect(contents(second)).toEqual(contents(first));
          expect(second.hash).toBe(first.hash);
        }).pipe(Effect.scoped),
      { tags: ["unit", "local"] },
    );
  }

  it.effect(
    "a written bundle names its files from the map's directory, where a reader finds them",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-bundle-source-map-" });
        const dir = (checkout: string) => path.join(root, checkout, "app/.alchemy/bundles/Fixture");

        const first = yield* build(
          root,
          { directory: "one/checkout", store: "one/store/aaaaaaaa", manager: "pnpm" },
          { dir: dir("one/checkout") },
        );
        const second = yield* build(
          root,
          { directory: "two/runner/work/checkout", store: "two/cache/bbbbbbbb", manager: "pnpm" },
          { dir: dir("two/runner/work/checkout") },
        );

        expect(sources(first)).toEqual(stableSources("pnpm", "../../../"));
        expect(second.hash).toBe(first.hash);
        for (const source of ["../../../../shared/greeting.ts", "../../../src/entry.ts"]) {
          expect(yield* fs.exists(path.resolve(dir("one/checkout"), source))).toBe(true);
        }
      }).pipe(Effect.scoped),
    { tags: ["unit", "local"] },
  );

  it.effect(
    "a changed comment leaves the code alone and still changes the map and the hash",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-bundle-source-map-" });

        const first = yield* build(root, {
          directory: "one/checkout",
          store: "one/store/aaaaaaaa",
          manager: "pnpm",
        });
        const changed = yield* build(root, {
          directory: "two/checkout",
          store: "two/store/bbbbbbbb",
          manager: "pnpm",
          note: "second",
        });

        for (const file of first.files) {
          const same = contents(changed)[file.path] === text(file);
          expect(same).toBe(!file.path.endsWith(".map"));
        }
        expect(changed.hash).not.toBe(first.hash);
      }).pipe(Effect.scoped),
    { tags: ["unit", "local"] },
  );

  it.effect(
    "a colon in a checkout's directory name is not taken for a module id",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-bundle-source-map-" });

        const first = yield* build(root, {
          directory: "job:1/checkout",
          store: "job:1/store/aaaaaaaa",
          manager: "pnpm",
        });
        const second = yield* build(root, {
          directory: "job:2/checkout",
          store: "job:2/store/bbbbbbbb",
          manager: "pnpm",
        });

        expect(sources(first)).toEqual(stableSources("pnpm", "../"));
        expect(second.hash).toBe(first.hash);
      }).pipe(Effect.scoped),
    { tags: ["unit", "local"] },
  );

  it.effect(
    "a checkout reached through a symlink names its files as one reached directly does",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-bundle-source-map-" });

        const direct = yield* build(root, {
          directory: "direct/checkout",
          store: "direct/store/aaaaaaaa",
          manager: "pnpm",
        });
        // As a temporary directory is on macOS (`/var` links to `/private/var`),
        // or a workspace a CI runner mounts under another name.
        yield* fs.makeDirectory(path.join(root, "disk"));
        yield* fs.symlink(path.join(root, "disk"), path.join(root, "linked"));
        const linked = yield* build(root, {
          directory: "linked/checkout",
          store: "linked/store/bbbbbbbb",
          manager: "pnpm",
        });

        expect(sources(linked)).toEqual(stableSources("pnpm", "../"));
        expect(linked.hash).toBe(direct.hash);
      }).pipe(Effect.scoped),
    { tags: ["unit", "local"] },
  );

  it.effect(
    "a colon in the name of a directory right below the process directory is not taken for a module id",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        // The deploy runs from the directory that holds the checkouts, and the
        // one they sit in has a colon in its name.
        const root = yield* fs.makeTempDirectoryScoped({
          directory: process.cwd(),
          prefix: "build:",
        });

        const first = yield* build(root, {
          directory: "one/checkout",
          store: "cache/store/aaaaaaaa",
          manager: "pnpm",
        });
        const second = yield* build(root, {
          directory: "two/checkout",
          store: "cache/store/bbbbbbbb",
          manager: "pnpm",
        });

        expect(sources(first)).toEqual(stableSources("pnpm", "../"));
        expect(second.hash).toBe(first.hash);
      }).pipe(Effect.scoped),
    { tags: ["unit", "local"] },
  );

  it.effect(
    "a caller's own sourcemapPathTransform wins",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-bundle-source-map-" });

        const result = yield* build(
          root,
          { directory: "one/checkout", store: "one/store/aaaaaaaa", manager: "pnpm" },
          { sourcemapPathTransform: (source) => `mine/${source.split("/").at(-1)}` },
        );

        expect(sources(result)).toEqual([
          "mine/entry.ts",
          "mine/greeting.ts",
          "mine/index.js",
          "mine/virtual:suffix",
        ]);
      }).pipe(Effect.scoped),
    { tags: ["unit", "local"] },
  );

  it.effect(
    "watch keeps rolldown's own paths",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-bundle-source-map-" });
        const checkout = yield* makeCheckout(root, {
          directory: "one/checkout",
          store: "one/store/aaaaaaaa",
          manager: "pnpm",
        });
        const dir = path.join(checkout.app, ".alchemy/bundles/Fixture");

        const output = yield* Bundle.watch(inputOf(checkout), { sourcemap: "hidden", dir }).pipe(
          Stream.filter((event) => event._tag !== "Start"),
          Stream.runHead,
          Effect.map((event) => {
            const result = Option.getOrThrow(event);
            if (result._tag !== "Success") {
              throw new Error(`watch build failed: ${result.error.message}`);
            }
            return result.output;
          }),
        );

        // The dependency is named where its store really sits, not below `cwd`.
        expect(sources(output).map((source) => path.resolve(dir, source))).toContain(
          yield* fs.realPath(path.join(checkout.app, "node_modules/fixture-dependency/index.js")),
        );
      }).pipe(Effect.scoped),
    { tags: ["unit", "local"] },
  );
});
