import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { afterEach, expect, it, vi } from "vitest";
import { makeVinextSourceProvider } from "../source.ts";

afterEach(() => vi.unstubAllEnvs());

it.each([
  { stage: "production", inheritsUndeclared: false },
  { stage: "local", inheritsUndeclared: true },
])(
  "builds declared public env for $stage",
  ({ stage, inheritsUndeclared }) => {
    vi.stubEnv("NEXT_PUBLIC_EXAMPLE", "inherited-example");
    vi.stubEnv("NEXT_PUBLIC_LOCAL_ONLY", "inherited-local-only");
    vi.stubEnv("NEXT_PUBLIC_NON_STRING", "inherited-non-string");
    return Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const example = yield* path.fromFileUrl(
            new URL("../../../../../examples/cloudflare-website-vinext/", import.meta.url),
          );
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "vinext-public-env-" });
          yield* fs.symlink(path.join(example, "node_modules"), path.join(root, "node_modules"));
          yield* fs.writeFileString(path.join(root, "package.json"), '{"type":"module"}');
          yield* fs.writeFileString(
            path.join(root, "vite.config.ts"),
            'import vinext from "vinext"; export default { envDir: false, plugins: [vinext()] };',
          );
          yield* fs.makeDirectory(path.join(root, "app"));
          yield* fs.writeFileString(
            path.join(root, "app/layout.tsx"),
            "export default function Layout({ children }) { return <html><body>{children}</body></html>; }",
          );
          yield* fs.writeFileString(
            path.join(root, "app/page.tsx"),
            '"use client"; export default function Page() { return <p>{process.env.NEXT_PUBLIC_EXAMPLE}:{process.env.NEXT_PUBLIC_LOCAL_ONLY}:{process.env.NEXT_PUBLIC_NON_STRING}</p>; }',
          );
          yield* fs.makeDirectory(path.join(root, "worker"));
          const main = path.join(root, "worker/index.ts");
          yield* fs.writeFileString(
            main,
            'export { default } from "vinext/server/app-router-entry";',
          );
          yield* makeVinextSourceProvider({
            rootDir: root,
            main,
            viteEnvironments: { entry: "rsc", children: ["ssr"] },
          }).build({
            id: "Web",
            workerName: "test-worker",
            stack: { name: "test", stage },
            compatibility: { date: "2026-05-12", flags: ["nodejs_compat"] },
            entry: { kind: "external" },
            env: { NEXT_PUBLIC_EXAMPLE: "declared-example", NEXT_PUBLIC_NON_STRING: 42 },
            extraOptions: undefined,
            assets: undefined,
          });
          const assets = path.join(root, "dist/client");
          const files = yield* fs.readDirectory(assets, { recursive: true });
          const code = (yield* Effect.forEach(
            files.filter((file) => file.endsWith(".js")),
            (file) => fs.readFileString(path.join(assets, file)),
          )).join("\n");
          expect(code.includes("declared-example")).toBe(true);
          expect(code.includes("inherited-example")).toBe(false);
          expect(code.includes("inherited-local-only")).toBe(inheritsUndeclared);
          expect(code.includes("inherited-non-string")).toBe(inheritsUndeclared);
          expect(process.env.NEXT_PUBLIC_EXAMPLE).toBe("inherited-example");
          expect(process.env.NEXT_PUBLIC_LOCAL_ONLY).toBe("inherited-local-only");
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  },
  120_000,
);
