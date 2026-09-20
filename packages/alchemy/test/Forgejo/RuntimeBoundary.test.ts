import { makeFunctionBundler } from "@/AWS/Lambda/FunctionBundle.ts";
import * as Bundle from "@/Bundle/Bundle.ts";
import { WorkerBundle } from "@/Cloudflare/Workers/Sources/Rolldown.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, layer } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

const assertRuntimeBoundary = (
  files: Bundle.BundleFile[],
  forbiddenModules: string[] = [],
) =>
  Effect.sync(() => {
    const code = files
      .filter((file) => file.path.endsWith(".js"))
      .map((file) =>
        typeof file.content === "string"
          ? file.content
          : new TextDecoder().decode(file.content),
      )
      .join("\n");
    expect(code).toContain("received issues");
    for (const forbidden of [
      "Automatic Forgejo token provisioning requires",
      "adminCreateUserAccessToken",
      ...forbiddenModules,
    ]) {
      expect({ forbidden, included: code.includes(forbidden) }).toEqual({
        forbidden,
        included: false,
      });
    }
  });

layer(NodeServices.layer)("Forgejo runtime boundary", (test) => {
  test.effect("host providers do not depend on Forgejo", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      for (const directory of ["src/AWS/Lambda", "src/Cloudflare/Workers"]) {
        const files = yield* fs.readDirectory(directory, { recursive: true });
        for (const file of files.filter((file) => file.endsWith(".ts"))) {
          expect(file).not.toContain("Forgejo");
          const source = yield* fs.readFileString(path.join(directory, file));
          expect(source).not.toMatch(
            /(?:from\s*|import\s*\()\s*["'][^"']*Forgejo/,
          );
        }
      }
    }),
  );

  test.effect("HTTP bindings do not import runtime providers", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const files = yield* fs.readDirectory("src/Forgejo");
      for (const file of files.filter((file) => file.endsWith("Http.ts"))) {
        const source = yield* fs.readFileString(path.join("src/Forgejo", file));
        expect(source).not.toMatch(
          /(?:from\s*|import\s*\()\s*["'][^"']*(?:AWS|Cloudflare|Fly|Hetzner|Railway)\//,
        );
      }
    }),
  );

  test.effect(
    "excludes deployment profile, token minting and CLI code from the Worker bundle",
    () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const bundler = yield* WorkerBundle;
        const output = yield* bundler.build({
          id: "ForgejoRuntimeBoundary",
          main: path.resolve("test/Forgejo/fixtures/worker.ts"),
          compatibility: { date: "2026-03-17", flags: ["nodejs_compat"] },
          entry: { kind: "effect", exports: {} },
          stack: { name: "ForgejoRuntimeBoundary", stage: "test" },
          extraOptions: undefined,
        });
        yield* assertRuntimeBoundary(output.files, [
          "Alchemy::ProfileStore",
          "loadProviderConfig",
          "@effect/platform-bun",
          "alchemy profile edit",
        ]);
      }),
    { timeout: 120_000 },
  );

  test.effect(
    "excludes Forgejo token minting from the Lambda bundle",
    () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const bundler = yield* makeFunctionBundler;
        const plan = yield* bundler.resolveBundlePlan({
          main: path.resolve("test/Forgejo/fixtures/lambda.ts"),
          functionUrl: true,
        });
        const output = yield* Bundle.build(
          plan.inputOptions,
          plan.outputOptions,
          plan.extra,
        );
        yield* assertRuntimeBoundary(output.files);
      }),
    { timeout: 120_000 },
  );
});
