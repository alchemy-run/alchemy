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
  readonly greeting?: string;
}

/**
 * Creates a checkout as a CI job has one: a package whose entry imports a
 * source outside the package and a dependency. The package manager keeps the
 * dependency in a store directory of its own and links it into the package's
 * `node_modules`.
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
        "export default { fetch: () => new Response(decorate(greeting)) };",
        "",
      ].join("\n"),
    );
    yield* write(
      path.join(root, checkout.directory, "shared/greeting.ts"),
      `export const greeting = ${JSON.stringify(checkout.greeting ?? "hello")};\n`,
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
 * Builds a checkout minified, as a Worker bundle is. Unminified code also
 * carries rolldown's module path comments, which no output option controls.
 */
const build = (root: string, checkout: Checkout, output?: rolldown.OutputOptions) =>
  Effect.gen(function* () {
    const { app, entry } = yield* makeCheckout(root, checkout);
    return yield* Bundle.build(
      { input: entry, cwd: app },
      { sourcemap: "hidden", minify: true, ...output },
    );
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

const stableSources = (manager: keyof typeof storeDirectory) => [
  "../shared/greeting.ts",
  `${storeDirectory[manager]}/index.js`,
  "src/entry.ts",
];

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

          expect(sources(first)).toEqual(stableSources(manager));
          expect(contents(second)).toEqual(contents(first));
          expect(second.hash).toBe(first.hash);
        }).pipe(Effect.scoped),
      { tags: ["unit", "local"] },
    );
  }

  it.effect(
    "build names sources the same way when the bundle is written to a directory",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-bundle-source-map-" });

        const inside = yield* build(
          root,
          { directory: "one/checkout", store: "one/store/aaaaaaaa", manager: "pnpm" },
          { dir: path.join(root, "one/checkout/app/.alchemy/bundles/Fixture") },
        );
        const outside = yield* build(
          root,
          { directory: "two/checkout", store: "two/store/bbbbbbbb", manager: "pnpm" },
          { dir: path.join(root, "two/elsewhere/out") },
        );

        expect(sources(inside)).toEqual(stableSources("pnpm"));
        expect(sources(outside)).toEqual(stableSources("pnpm"));
        expect(outside.hash).toBe(inside.hash);
      }).pipe(Effect.scoped),
    { tags: ["unit", "local"] },
  );

  it.effect(
    "a changed source still changes the code, the map and the hash",
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
          greeting: "hello, changed",
        });

        for (const file of first.files) {
          expect(contents(changed)[file.path]).not.toBe(text(file));
        }
        expect(changed.hash).not.toBe(first.hash);
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

        expect(sources(result)).toEqual(["mine/entry.ts", "mine/greeting.ts", "mine/index.js"]);
      }).pipe(Effect.scoped),
    { tags: ["unit", "local"] },
  );

  it.effect(
    "watch keeps paths that lead from the map to the files on disk",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-bundle-source-map-" });
        const { app, entry } = yield* makeCheckout(root, {
          directory: "one/checkout",
          store: "one/store/aaaaaaaa",
          manager: "pnpm",
        });
        const dir = path.join(app, ".alchemy/bundles/Fixture");

        const output = yield* Bundle.watch(
          { input: entry, cwd: app },
          { sourcemap: "hidden", dir },
        ).pipe(
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

        expect(sources(output).map((source) => path.resolve(dir, source))).toContain(
          yield* fs.realPath(entry),
        );
      }).pipe(Effect.scoped),
    { tags: ["unit", "local"] },
  );
});
