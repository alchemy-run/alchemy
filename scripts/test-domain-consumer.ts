// Runs a Domain verification the way a consumer of the published package
// does: in a new project outside the workspace, with `@alchemy.run/domain`
// and `alchemy` installed from the preview registry.
//
// Inside the workspace the package is source the test runner transforms, so
// a file `Verify` reads is the module the test already imported. Installed,
// the package is external: the file is loaded a second time, and its classes
// have to be matched to the test's. Only an install outside the workspace
// sees that.
//
// Usage: node scripts/test-domain-consumer.ts [--tag pr:3260:f5eaae7]
//
// Without `--tag` it installs the tarballs `pkg pack` just wrote a manifest
// for (`.pkg/pkg-manifest.json`), and does nothing when that pack left
// `@alchemy.run/domain` out.
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Command, Flag } from "effect/cli";
import * as Console from "effect/Console";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { ChildProcess } from "effect/process";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";
import * as Schema from "effect/Schema";

class ConsumerFailed extends Data.TaggedError("ConsumerFailed")<{ readonly message: string }> {}

const REGISTRY = "https://pkg.alchemy.run";
const PACKAGES = ["@alchemy.run/domain", "alchemy"] as const;
/** What the consumer's test needs besides the two packages, at the versions the workspace has. */
const TOOLS = ["effect", "@effect/platform-node", "@effect/vitest", "vitest"] as const;

const Manifest = Schema.Struct({
  registry: Schema.String,
  packages: Schema.Array(Schema.Struct({ name: Schema.String, sha256: Schema.String })),
});
const Versioned = Schema.Struct({ version: Schema.String });

const run = Effect.fn(function* (command: string, args: ReadonlyArray<string>, cwd: string) {
  const spawner = yield* ChildProcessSpawner;
  const code = yield* spawner.exitCode(
    ChildProcess.make(command, args, { cwd, stdout: "inherit", stderr: "inherit" }),
  );
  if (code !== 0)
    return yield* new ConsumerFailed({ message: `${command} ${args.join(" ")} exited ${code}` });
});

/** Where to install each package from: a tag, or the tarballs of the last pack. */
const sources = Effect.fn(function* (root: string, tag: Option.Option<string>) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (Option.isSome(tag))
    return Object.fromEntries(PACKAGES.map((name) => [name, `${REGISTRY}/${name}/${tag.value}`]));
  const file = path.join(root, ".pkg", "pkg-manifest.json");
  if (!(yield* fs.exists(file))) return undefined;
  const manifest = yield* Schema.decodeEffect(Schema.fromJsonString(Manifest))(
    yield* fs.readFileString(file),
  );
  const urls: Record<string, string> = {};
  for (const name of PACKAGES) {
    const packed = manifest.packages.find((entry) => entry.name === name);
    if (!packed) return undefined;
    urls[name] = `${manifest.registry}/${name}/-/${packed.sha256}.tgz`;
  }
  return urls;
});

const command = Command.make(
  "test-domain-consumer",
  {
    tag: Flag.String("tag").pipe(
      Flag.withDescription("A registry tag to install, such as pr:3260:f5eaae7 or branch:main"),
      Flag.optional,
    ),
  },
  Effect.fn(function* ({ tag }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = path.resolve(import.meta.dirname, "..");
    const example = path.join(root, "examples", "cloudflare-domain", "packages", "domain");

    const packages = yield* sources(root, tag);
    if (!packages)
      return yield* Console.log(
        "No packed @alchemy.run/domain to install: pass --tag, or run `pkg pack` first.",
      );

    const versionAt = Effect.fn(function* (directory: string) {
      const manifest = yield* fs.readFileString(path.join(directory, "package.json"));
      return (yield* Schema.decodeEffect(Schema.fromJsonString(Versioned))(manifest)).version;
    });
    const tools: Record<string, string> = {};
    for (const name of TOOLS)
      tools[name] = yield* versionAt(path.join(example, "node_modules", name));
    // vitest's peer, which npm installs only when asked: the one the workspace's vitest runs on.
    const vitest = yield* fs.realPath(path.join(example, "node_modules", "vitest"));
    tools.vite = yield* versionAt(path.join(vitest, "..", "vite"));

    // A temporary directory is outside the workspace: nothing above it has a
    // `node_modules`, so only what is installed here resolves.
    const project = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-domain-consumer-" });
    yield* fs.copy(path.join(example, "src"), path.join(project, "src"));
    yield* fs.makeDirectory(path.join(project, "test"));
    yield* fs.copyFile(
      path.join(example, "test", "Consumer.test.ts"),
      path.join(project, "test", "Consumer.test.ts"),
    );
    yield* fs.writeFileString(
      path.join(project, "package.json"),
      `${JSON.stringify(
        {
          name: "domain-consumer",
          private: true,
          type: "module",
          dependencies: { ...packages, effect: tools.effect },
          devDependencies: Object.fromEntries(
            Object.entries(tools).filter(([name]) => name !== "effect"),
          ),
        },
        null,
        2,
      )}\n`,
    );

    yield* Console.log(`Installing ${Object.values(packages).join(" and ")} in ${project}`);
    yield* run("npm", ["install", "--no-audit", "--no-fund", "--legacy-peer-deps"], project);
    yield* run("npx", ["vitest", "run"], project);
  }, Effect.scoped),
);

Command.run(command, { version: "0.0.0" }).pipe(
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
