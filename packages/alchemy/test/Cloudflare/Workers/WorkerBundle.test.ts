import * as Cloudflare from "@/Cloudflare";
import { WorkerBundle } from "@/Cloudflare/Workers/Sources/Rolldown";
import * as Alchemy from "@/index.ts";
import * as Test from "@/Test/Alchemy";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, layer } from "alchemy-test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import RequireNodeBuiltinsWorker from "./fixtures/require-node-builtins/worker.ts";
import WorkflowValidationWorker from "./fixtures/workflow-exports/effect-worker.ts";

const decode = (content: string | Uint8Array<ArrayBufferLike>) =>
  typeof content === "string"
    ? content
    : new TextDecoder().decode(content as Uint8Array);

/**
 * Write `files` (paths relative to a fresh temp directory) and return
 * the temp directory's absolute path.
 */
const writeFixture = Effect.fn(function* (files: Record<string, string>) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectory({
    prefix: "alchemy-worker-bundle-",
  });
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(root, name);
    yield* fs.makeDirectory(path.dirname(file), { recursive: true });
    yield* fs.writeFileString(file, content);
  }
  return root;
});

layer(NodeServices.layer)("WorkerBundle", (it) => {
  it.effect("adds Workflow export checks to external Worker bundles", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const root = yield* writeFixture({
        "package.json": "{}",
        "worker.mjs": [
          `export class GuideWorkflow {}`,
          `export default { fetch: () => new Response("ok") };`,
        ].join("\n"),
      });

      const bundler = yield* WorkerBundle;
      const output = yield* bundler.build({
        id: "external-effect-workflow",
        main: path.join(root, "worker.mjs"),
        compatibility: { date: "2026-03-17", flags: [] },
        entry: {
          kind: "external",
          workflowClassNames: ["GuideWorkflow"],
        },
        stack: { name: "worker-bundle-test", stage: "test" },
        extraOptions: undefined,
      });

      const bundle = output.files.map((file) => decode(file.content)).join();
      expect(bundle).toContain(
        "is configured as a Workflow but does not extend cloudflare:workers WorkflowEntrypoint",
      );
      expect(bundle).toContain("Import and yield the Effect Worker class");
    }),
  );

  // Regression test for #880: CJS dependencies (like `pg`) that
  // `require("events")` must have those requires converted into ESM imports
  // of the workerd-provided Node builtins. Left unconverted, rolldown emits
  // a throwing `require` fallback and the Worker fails Cloudflare startup
  // validation with "Calling `require` for \"events\" in an environment
  // that doesn't expose the `require` function".
  it.effect(
    "converts CJS requires of Node builtins into ESM imports under nodejs_compat",
    () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const root = yield* writeFixture({
          // Anchors findCwdForBundle so bundle output stays in the temp dir.
          "package.json": "{}",
          "dep.cjs": [
            `const { EventEmitter } = require("events");`,
            `const util = require("node:util");`,
            `module.exports = {`,
            `  Thing: class extends EventEmitter {`,
            `    describe() { return util.format("thing %s", "one"); }`,
            `  },`,
            `};`,
          ].join("\n"),
          "worker.mjs": [
            `import { Thing } from "./dep.cjs";`,
            `export default {`,
            `  fetch: () => new Response(new Thing().describe()),`,
            `};`,
          ].join("\n"),
        });

        const bundler = yield* WorkerBundle;
        const output = yield* bundler.build({
          id: "worker-bundle-require-events",
          main: path.join(root, "worker.mjs"),
          compatibility: { date: "2026-03-17", flags: ["nodejs_compat"] },
          entry: { kind: "external" },
          stack: { name: "worker-bundle-test", stage: "test" },
          extraOptions: undefined,
        });

        const entry = decode(output.files[0].content);
        // The CJS requires were rewritten to imports of the builtins.
        expect(entry).toMatch(/from\s*["'](?:node:)?events["']/);
        expect(entry).toMatch(/from\s*["']node:util["']/);
        // No chunk retains rolldown's throwing `require` fallback.
        for (const file of output.files) {
          if (!file.path.endsWith(".js")) continue;
          expect(decode(file.content)).not.toContain("Calling `require` for");
        }
      }),
  );
  it.effect(
    "applies input aliases before Node compatibility for imports and requires",
    () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const root = yield* writeFixture({
          "package.json": "{}",
          "stub.mjs": `export const createRequire = () => "ALIASED_MODULE"; export default "ALIASED_PACKAGE";`,
          "worker.mjs": `
          import { createRequire } from "module";
          import { createRequire as nodeCreateRequire } from "node:module";
          import ts from "typescript";
          import execa from "execa";
          import readable from "readable-stream";
          const bare = require("module");
          const prefixed = require("node:module");
          export default { fetch: () => Response.json([
            createRequire(undefined), nodeCreateRequire(undefined),
            bare.createRequire(undefined), prefixed.createRequire(undefined),
            ts, execa, readable, BUILD_MARKER,
          ]) };
        `,
        });
        const bundler = yield* WorkerBundle;
        const output = yield* bundler.build({
          id: "worker-bundle-alias",
          main: path.join(root, "worker.mjs"),
          compatibility: { date: "2025-04-01", flags: ["nodejs_compat"] },
          entry: { kind: "external" },
          stack: { name: "worker-bundle-test", stage: "test" },
          extraOptions: {
            input: {
              resolve: {
                alias: Object.fromEntries(
                  [
                    "module",
                    "node:module",
                    "typescript",
                    "execa",
                    "readable-stream",
                  ].map((name) => [name, path.join(root, "stub.mjs")]),
                ),
              },
              transform: {
                define: {
                  BUILD_MARKER: JSON.stringify("INPUT_OPTIONS_MARKER"),
                },
              },
            },
          },
        });
        const entry = decode(output.files[0].content);
        expect(entry).toContain("ALIASED_MODULE");
        expect(entry).toContain("ALIASED_PACKAGE");
        expect(entry).toContain("INPUT_OPTIONS_MARKER");
        expect(entry).not.toMatch(/from\s*["'](?:node:)?module["']/);
        expect(entry).not.toContain("Calling `require` for");
      }),
  );
  it.effect(
    "preserves native alias matching, fallback arrays, and disabled modules",
    () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const root = yield* writeFixture({
          "package.json": "{}",
          "stub.mjs": `export default "NATIVE_ALIAS_MARKER";`,
          "stubs/promises.mjs": `export default "SUBPATH_ALIAS_MARKER";`,
          "worker.mjs": `
          import module from "module";
          import promises from "node:fs/promises";
          import ignored from "node:inspector";
          import { createRequire } from "node:module";
          export default { fetch: () => Response.json([module, promises, ignored, typeof createRequire]) };
        `,
        });
        const bundler = yield* WorkerBundle;
        for (const fsAlias of ["node:fs", "node:fs/*"]) {
          const output = yield* bundler.build({
            id: "worker-bundle-native-alias",
            main: path.join(root, "worker.mjs"),
            compatibility: { date: "2025-04-01", flags: ["nodejs_compat"] },
            entry: { kind: "external" },
            stack: { name: "worker-bundle-test", stage: "test" },
            extraOptions: {
              input: {
                resolve: {
                  alias: {
                    module$: [
                      path.join(root, "missing.mjs"),
                      path.join(root, "stub.mjs"),
                    ],
                    [fsAlias]: path.join(
                      root,
                      fsAlias.includes("*") ? "stubs/*" : "stubs",
                    ),
                    "node:inspector": false,
                    "node:module": [],
                  },
                },
              },
            },
          });
          const entry = decode(output.files[0].content);
          expect(entry).toContain("NATIVE_ALIAS_MARKER");
          expect(entry).toContain("SUBPATH_ALIAS_MARKER");
          expect(entry).toMatch(/from\s*["']node:module["']/);
          expect(entry).not.toMatch(
            /from\s*["'](?:module|node:fs\/promises|node:inspector)["']/,
          );
        }
      }),
  );

  it.effect("uses input plugins and aliases when watching", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const root = yield* writeFixture({
        "package.json": "{}",
        "stub.mjs": `export const createRequire = () => "WATCH_ALIAS_MARKER";`,
        "worker.mjs": `import { createRequire } from "node:module"; import value from "virtual:custom"; export default { fetch: () => new Response(createRequire(undefined) + value) };`,
      });
      const bundler = yield* WorkerBundle;
      const events = yield* bundler
        .watch({
          id: "worker-bundle-watch-alias",
          main: path.join(root, "worker.mjs"),
          compatibility: { date: "2025-04-01", flags: ["nodejs_compat"] },
          entry: { kind: "external" },
          stack: { name: "worker-bundle-test", stage: "test" },
          extraOptions: {
            input: {
              resolve: {
                alias: { "node:module": path.join(root, "stub.mjs") },
              },
              plugins: [
                {
                  name: "custom-input-plugin",
                  resolveId(id) {
                    if (id === "virtual:custom") return "\u0000custom";
                  },
                  load(id) {
                    if (id === "\u0000custom")
                      return `export default "INPUT_PLUGIN_MARKER";`;
                  },
                },
              ],
            },
          },
        })
        .pipe(
          Stream.filter((event) => event._tag !== "Start"),
          Stream.take(1),
          Stream.runCollect,
        );
      const event = events[0]!;
      expect(event._tag).toBe("Success");
      if (event._tag === "Success") {
        const entry = decode(event.output.files[0].content);
        expect(entry).toContain("WATCH_ALIAS_MARKER");
        expect(entry).toContain("INPUT_PLUGIN_MARKER");
        expect(entry).not.toMatch(/from\s*["']node:module["']/);
      }
    }),
  );
  // `?worker` imports (WorkerModulePlugin.ts): the target is bundled into
  // one self-contained module and imported as a STRING, ready for a
  // `WorkerLoader`. Nested `?worker` imports inside the target work too.
  it.effect(
    "bundles a ?worker import into a string, nested imports included",
    () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const root = yield* writeFixture({
          "package.json": "{}",
          "stub.mjs": `export const createRequire = () => "NESTED_ALIAS_MARKER";`,
          "grandchild.mjs": [
            `import { createRequire } from "node:module";`,
            `export default { fetch: () => new Response("GRANDCHILD_MARKER" + createRequire(undefined)) };`,
          ].join("\n"),
          "child.mjs": [
            `import grandchild from "./grandchild.mjs?worker";`,
            `export const MARKER = "CHILD_MARKER_";`,
            `export default { fetch: () => new Response(MARKER + grandchild) };`,
          ].join("\n"),
          "worker.mjs": [
            `import child from "./child.mjs?worker";`,
            `export default {`,
            `  fetch: () => new Response(typeof child + ":" + child.length),`,
            `};`,
          ].join("\n"),
        });
        const bundler = yield* WorkerBundle;
        const output = yield* bundler.build({
          id: "worker-bundle-worker-module",
          main: path.join(root, "worker.mjs"),
          compatibility: { date: "2026-03-17", flags: ["nodejs_compat"] },
          entry: { kind: "external" },
          stack: { name: "worker-bundle-test", stage: "test" },
          extraOptions: {
            input: {
              resolve: {
                alias: { "node:module": path.join(root, "stub.mjs") },
              },
            },
          },
        });
        const entry = decode(output.files[0].content);
        // The child's code is embedded as a JSON string literal …
        expect(entry).toContain("CHILD_MARKER_");
        // … which itself embeds the grandchild's code (one more level).
        expect(entry).toContain("GRANDCHILD_MARKER");
        expect(entry).toContain("NESTED_ALIAS_MARKER");
        // `child` is a string in the parent, not a module namespace.
        expect(entry).not.toContain("import child from");
      }),
  );
});

describe("integration", () => {
  const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
    providers: Cloudflare.providers(),
  });

  const Stack = Alchemy.Stack(
    "NodeBuiltinRequireTestStack",
    { providers: Cloudflare.providers(), state: Cloudflare.state() },
    Effect.gen(function* () {
      const worker = yield* RequireNodeBuiltinsWorker;
      const path = yield* Path.Path;
      const stub = yield* path
        .fromFileUrl(
          new URL("./fixtures/module-alias/stub.mjs", import.meta.url),
        )
        .pipe(Effect.orDie);
      const aliased = yield* Cloudflare.Worker("AliasedWorker", {
        main: new URL("./fixtures/module-alias/worker.mjs", import.meta.url)
          .href,
        compatibility: {
          date: "2025-04-01",
          flags: ["nodejs_compat", "nodejs_compat_populate_process_env"],
        },
        build: {
          input: {
            resolve: {
              alias: Object.fromEntries(
                [
                  "module",
                  "node:module",
                  "typescript",
                  "execa",
                  "readable-stream",
                ].map((name) => [name, stub]),
              ),
            },
          },
        },
      });
      return {
        url: worker.url.as<string>(),
        aliasUrl: aliased.url.as<string>(),
      };
    }),
  );

  const stack = beforeAll(destroy(Stack).pipe(Effect.andThen(deploy(Stack))));
  afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

  test(
    "worker aliases override Node builtins without breaking other requires",
    Effect.gen(function* () {
      const { aliasUrl } = yield* stack;
      const client = yield* HttpClient.HttpClient;
      const body = yield* client.get(aliasUrl).pipe(
        Effect.flatMap((response) => response.json),
        Effect.retry({ schedule: Schedule.spaced("1 second"), times: 8 }),
      );
      expect(body).toEqual({
        bare: "aliased:module",
        prefixed: "aliased:module",
        cjsBare: "aliased:module",
        cjsPrefixed: "aliased:module",
        typescript: "aliased:package",
        execa: "aliased:package",
        readable: "aliased:package",
        event: "builtin:ok",
      });
    }),
  );

  // Regression test for #880: the deploy itself is the primary assertion —
  // a bundle that keeps rolldown's throwing `require` fallback for
  // `require("events")` fails Cloudflare startup validation at upload time
  // and `beforeAll(deploy(Stack))` fails the suite.
  test(
    "worker with a CJS dep requiring node builtins deploys and serves",
    Effect.gen(function* () {
      const { url } = yield* stack;
      const client = yield* HttpClient.HttpClient;

      const get = client.get(`${url}/?value=pong`).pipe(
        Effect.flatMap((res) => res.text),
        Effect.retry({
          schedule: Schedule.exponential("500 millis"),
          times: 5,
        }),
        Effect.orDie,
      );

      // Fresh workers.dev URLs can serve placeholder 200s while propagating,
      // so anchor the readiness poll on the fixture's marker, not the status.
      const body = yield* get.pipe(
        Effect.repeat({
          schedule: Schedule.exponential("500 millis"),
          until: (b) => b.includes("require-node-builtins:"),
          times: 10,
        }),
      );

      // The converted builtins really work at runtime: the EventEmitter
      // round-tripped the request's value and util.format made the marker.
      expect(body).toBe("require-node-builtins:pong");
    }),
    { timeout: 180_000 },
  );
});

const workflowMain = (file: string) =>
  new URL(`./fixtures/workflow-exports/${file}`, import.meta.url).href;

const assertWorkflow = Effect.fn(function* (url: string) {
  const ready = yield* Test.getWhenReady(url, { times: 6 });
  expect(yield* ready.text).toBe("workflow-export-ready");
  const client = yield* HttpClient.HttpClient;
  const started = yield* client.post(`${url}/start`);
  if (started.status !== 200) {
    return yield* Effect.fail(
      new Error(
        `Workflow start failed (${started.status}): ${yield* started.text}`,
      ),
    );
  }
  const { instanceId } = yield* started.json.pipe(
    Effect.flatMap(
      Schema.decodeUnknownEffect(Schema.Struct({ instanceId: Schema.String })),
    ),
  );
  const status = yield* client.get(`${url}/status/${instanceId}`).pipe(
    Effect.flatMap((response) => response.json),
    Effect.flatMap(
      Schema.decodeUnknownEffect(
        Schema.Struct({
          status: Schema.String,
          output: Schema.optional(
            Schema.NullOr(Schema.Struct({ value: Schema.String })),
          ),
          error: Schema.optional(Schema.Unknown),
        }),
      ),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      times: 10,
      until: (result) =>
        ["complete", "errored", "terminated"].includes(result.status),
    }),
  );
  expect(status).toMatchObject({
    status: "complete",
    output: { value: "workflow-export-ok" },
  });
});

for (const dev of [true, false]) {
  describe(`Workflow export validation (${dev ? "local" : "live"})`, () => {
    const { test } = Test.make({ providers: Cloudflare.providers(), dev });

    for (const { label, main, className } of [
      {
        label: "Effect-native",
        main: "effect-worker.ts",
        className: "ValidationWorkflow",
      },
      { label: "missing", main: "native.ts", className: "MissingWorkflow" },
    ]) {
      test.provider(
        `rejects ${label} Workflow exports through the external Worker API`,
        (stack) =>
          Effect.gen(function* () {
            yield* stack.destroy();
            const deploy = stack.deploy(
              Cloudflare.Worker("InvalidWorkflowWorker", {
                main: workflowMain(main),
                env: { VALIDATION_WORKFLOW: Cloudflare.Workflow(className) },
              }),
            );
            let message: string;
            if (dev) {
              const worker = yield* deploy;
              const client = yield* HttpClient.HttpClient;
              // Trigger startup without invoking the invalid Workflow.
              const response = yield* client.get(worker.url!);
              message = yield* response.text;
              expect(response.status).toBe(502);
            } else {
              const result = yield* deploy.pipe(Effect.exit);
              expect(Exit.isFailure(result)).toBe(true);
              if (Exit.isSuccess(result)) return;
              message = Cause.pretty(result.cause);
            }
            expect(message).toContain(className);
            expect(message).toContain("is configured as a Workflow");
            expect(message).toContain(
              "Import and yield the Effect Worker class",
            );
            yield* stack.destroy();
          }),
        { timeout: 120_000 },
      );
    }

    for (const main of ["native.ts", "native-only.ts"]) {
      test.provider(
        `runs native and cross-script Workflows from ${main}`,
        (stack) =>
          Effect.gen(function* () {
            yield* stack.destroy();
            const Host = Cloudflare.Worker("WorkflowHost", {
              main: workflowMain(main),
              env: {
                VALIDATION_WORKFLOW: Cloudflare.Workflow("ValidationWorkflow"),
              },
            });
            const host = yield* stack.deploy(Host);
            if (dev) {
              // Local hosts start lazily on their first request.
              const client = yield* HttpClient.HttpClient;
              yield* client.get(host.url!);
            }
            const deployed = yield* stack.deploy(
              Effect.gen(function* () {
                const host = yield* Host;
                const consumer = yield* Cloudflare.Worker("WorkflowConsumer", {
                  main: workflowMain("client.ts"),
                  env: {
                    VALIDATION_WORKFLOW: Cloudflare.Workflow(
                      "ValidationWorkflow",
                      {
                        scriptName: host.workerName,
                      },
                    ),
                  },
                });
                return { host, consumer };
              }),
            );
            yield* assertWorkflow(deployed.consumer.url!);
            if (main === "native.ts") yield* assertWorkflow(deployed.host.url!);
            yield* stack.destroy();
          }),
        { timeout: 120_000 },
      );
    }

    test.provider(
      "runs Effect-native Workflow exports through the Effect Worker API",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const deployed = yield* stack.deploy(
            Effect.gen(function* () {
              const worker = yield* WorkflowValidationWorker;
              return { worker };
            }),
          );
          yield* assertWorkflow(deployed.worker.url!);
          yield* stack.destroy();
        }),
      { timeout: 120_000 },
    );
  });
}
