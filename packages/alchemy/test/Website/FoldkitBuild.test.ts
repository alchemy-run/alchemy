import { make } from "@alchemy.run/frontend-frameworks/foldkit";
import { makeAwsTarget } from "@alchemy.run/frontend-frameworks/foldkit/aws";
import { makeNodeTarget } from "@alchemy.run/frontend-frameworks/foldkit/node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, layer } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import { pathToFileURL } from "node:url";
import { cloneFixture } from "../Cloudflare/Utils/Fixture.ts";

const fixture = (ssr: boolean) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    return yield* cloneFixture(
      path.join(
        import.meta.dirname,
        "../Cloudflare/Website",
        ssr ? "foldkit-ssr-fixture" : "foldkit-fixture",
      ),
      {
        prefix: "foldkit-host-build-",
        tempRoot: path.resolve(import.meta.dirname, "../../.tmp"),
        entries: ["index.html", "package.json", "vite.config.ts", "src"],
      },
    );
  });

const probe = (script: string) =>
  Effect.gen(function* () {
    const child = yield* ChildProcess.make(
      "node",
      ["--input-type=module", "-e", script],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [code, stdout, stderr] = yield* Effect.all(
      [
        child.exitCode,
        child.stdout.pipe(Stream.decodeText, Stream.mkString),
        child.stderr.pipe(Stream.decodeText, Stream.mkString),
      ],
      { concurrency: 3 },
    ).pipe(Effect.timeout("15 seconds"));
    expect({ code, stderr: code === 0 ? "" : stderr }).toEqual({
      code: 0,
      stderr: "",
    });
    return stdout;
  });

layer(NodeServices.layer)("Foldkit provider build contracts", (it) => {
  for (const platform of ["aws", "node", "neon"] as const) {
    it.effect(
      `${platform}: builds and hosts Foldkit's generated SSR handler with prerendered pages`,
      () =>
        Effect.gen(function* () {
          const root = yield* fixture(true);
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          // Distinguish prerendered / from request-time rendering and exercise root routing.
          yield* fs.writeFileString(
            path.join(root, "src/prerender.ts"),
            'export const prerenderPaths = ["/", "/about"];\n',
          );
          const framework = yield* make({
            root,
            target:
              platform === "aws"
                ? (config) => makeAwsTarget({ ...config, streaming: false })
                : `@alchemy.run/frontend-frameworks/foldkit/${platform}`,
            output: "server",
            vite: { outDir: "custom-output" },
          });
          const output = yield* framework.build();
          expect(output.distDirectory).toBe(
            path.join(root, ".alchemy/foldkit"),
          );
          expect(
            yield* fs.exists(
              path.join(root, "custom-output/client/about/index.html"),
            ),
          ).toBe(true);
          expect(
            yield* fs.exists(path.join(root, "custom-output/server/fetch.js")),
          ).toBe(true);
          expect(
            yield* fs.readFileString(
              path.join(output.clientDirectory!, "about/index.html"),
            ),
          ).toContain(">0<");
          const entry = path.join(
            output.distDirectory!,
            output.serverModules![0]!.name,
          );
          if (platform === "node") {
            // Inspect the bundled handler independently of the Node routing tests.
            expect(output.nodeServe?.serveRootIndex).toBe(true);
            expect(output.nodeServe?.notFoundHandling).toBe("none");
            const source = `import { default: handler } from ${JSON.stringify(pathToFileURL(path.join(output.distDirectory!, "server/fetch.js")).href)};
const response = await handler.fetch(new Request("https://example.test/dynamic?count=7"));
if (response.status !== 200 || !(await response.text()).includes(">7<")) throw new Error("SSR failed");
console.log("FOLDKIT_HANDLER_OK");`;
            expect(yield* probe(source)).toContain("FOLDKIT_HANDLER_OK");
          } else if (platform === "neon") {
            expect(
              yield* probe(`import { default: handler } from ${JSON.stringify(pathToFileURL(entry).href)};
for (const [pathname, expected] of [["/?count=7", ">0<"], ["/about?count=7", ">0<"], ["/dynamic?count=7", ">7<"]]) {
  const response = await handler.fetch(new Request("https://example.test" + pathname));
  if (response.status !== 200 || !(await response.text()).includes(expected)) throw new Error("Wrong rendering for " + pathname);
}
const missing = await handler.fetch(new Request("https://example.test/assets/missing.js"));
if (missing.status !== 404) throw new Error("Missing assets must 404");
console.log("FOLDKIT_NEON_OK");`),
            ).toContain("FOLDKIT_NEON_OK");
          } else {
            expect(
              yield* probe(`import { handler } from ${JSON.stringify(pathToFileURL(entry).href)};
const response = await handler({ version: "2.0", rawPath: "/dynamic", rawQueryString: "count=7", headers: { host: "example.test" }, requestContext: { http: { method: "GET" } } });
if (response.statusCode !== 200 || !response.body.includes(">7<")) throw new Error("Lambda SSR failed");
console.log("FOLDKIT_LAMBDA_OK");`),
            ).toContain("FOLDKIT_LAMBDA_OK");
          }
        }),
      { tags: ["unit", "local"], timeout: 120_000 },
    );
  }

  it.effect(
    "keeps SPA builds assets-only on AWS and supplies SPA routing on Node",
    () =>
      Effect.gen(function* () {
        const root = yield* fixture(false);
        const framework = yield* make({
          root,
          target: makeAwsTarget(),
          output: "spa",
        });
        const output = yield* framework.build();
        expect(output.serverModules).toBeUndefined();
        const node = yield* makeNodeTarget().finish!(output, {
          root,
          framework: "foldkit",
        });
        expect(node.nodeServe?.handler).toBeUndefined();
        expect(node.nodeServe?.notFoundHandling).toBe("spa");
      }),
    { tags: ["unit", "local"], timeout: 120_000 },
  );

  it.effect(
    "deploys prerendered assets without Lambda when static output is selected",
    () =>
      Effect.gen(function* () {
        const root = yield* fixture(true);
        const framework = yield* make({
          root,
          target: "@alchemy.run/frontend-frameworks/foldkit/aws",
          output: "static",
        });
        const output = yield* framework.build();
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        expect(output.serverModules).toBeUndefined();
        expect(
          yield* fs.exists(path.join(output.distDirectory!, "server")),
        ).toBe(false);
        expect(
          yield* fs.readFileString(
            path.join(output.clientDirectory!, "about/index.html"),
          ),
        ).toContain(">0<");
      }),
    { tags: ["unit", "local"], timeout: 120_000 },
  );
});
