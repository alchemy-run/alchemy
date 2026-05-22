import * as Bundle from "@/Bundle/Bundle";
import { rawPlugin, RAW_RE, splitFileAndPostfix } from "@/Bundle/RawPlugin";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as nodeFs from "node:fs/promises";

describe("Bundle.build with rawPlugin", () => {
  it.effect("inlines a sibling file imported with ?raw", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({
        prefix: "alchemy-raw-bundle-",
      });
      yield* fs.writeFileString(
        path.join(root, "hello.txt"),
        "HELLO_RAW_MARKER",
      );
      const entry = path.join(root, "entry.ts");
      yield* fs.writeFileString(
        entry,
        `import txt from "./hello.txt?raw";\nconsole.log(txt);\n`,
      );

      const result = yield* Bundle.build({
        input: entry,
        cwd: root,
      });

      const code = result.files
        .filter((f) => typeof f.content === "string")
        .map((f) => f.content as string)
        .join("\n");
      expect(code).toContain(`"HELLO_RAW_MARKER"`);
      // The bundle should not emit hello.txt as a separate asset.
      expect(result.files.every((f) => !f.path.endsWith("hello.txt"))).toBe(
        true,
      );

      yield* fs.remove(root, { recursive: true });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("resolves ?raw imports through subdirectories", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({
        prefix: "alchemy-raw-subdir-",
      });
      yield* fs.makeDirectory(path.join(root, "sub"), { recursive: true });
      yield* fs.writeFileString(
        path.join(root, "sub", "foo.json"),
        `{"marker":"SUBDIR_RAW_MARKER"}`,
      );
      const entry = path.join(root, "entry.ts");
      yield* fs.writeFileString(
        entry,
        `import foo from "./sub/foo.json?raw";\nconsole.log(foo);\n`,
      );

      const result = yield* Bundle.build({
        input: entry,
        cwd: root,
      });

      const code = result.files
        .filter((f) => typeof f.content === "string")
        .map((f) => f.content as string)
        .join("\n");
      expect(code).toContain("SUBDIR_RAW_MARKER");

      yield* fs.remove(root, { recursive: true });
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("rawPlugin load hook", () => {
  it.effect("inlines a .txt file as a JSON-encoded default export", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({ prefix: "alchemy-raw-load-" });
      const file = path.join(root, "hello.txt");
      yield* fs.writeFileString(file, "Hello, World!\n");

      const plugin = rawPlugin();
      const result = (yield* Effect.promise(() =>
        callLoad(plugin, `${file}?raw`),
      )) as { code: string; moduleType: string };

      expect(result.code).toBe(`export default "Hello, World!\\n";`);
      expect(result.moduleType).toBe("js");

      yield* fs.remove(root, { recursive: true });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("inlines a .json file verbatim (no parsing)", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({ prefix: "alchemy-raw-json-" });
      const file = path.join(root, "data.json");
      const raw = `{"a": 1, "b": "two"}`;
      yield* fs.writeFileString(file, raw);

      const plugin = rawPlugin();
      const result = (yield* Effect.promise(() =>
        callLoad(plugin, `${file}?raw`),
      )) as { code: string };

      expect(result.code).toBe(`export default ${JSON.stringify(raw)};`);

      yield* fs.remove(root, { recursive: true });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("strips additional query params before reading the file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({ prefix: "alchemy-raw-q-" });
      const file = path.join(root, "page.html");
      yield* fs.writeFileString(file, "<h1>hi</h1>");

      const plugin = rawPlugin();
      const result = (yield* Effect.promise(() =>
        callLoad(plugin, `${file}?raw&t=12345`),
      )) as { code: string };

      expect(result.code).toBe(`export default "<h1>hi</h1>";`);

      yield* fs.remove(root, { recursive: true });
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("RAW_RE", () => {
  it("matches `?raw`", () => {
    expect(RAW_RE.test("/foo/bar.txt?raw")).toBe(true);
  });

  it("matches `?raw&foo`", () => {
    expect(RAW_RE.test("/foo/bar.txt?raw&foo")).toBe(true);
  });

  it("matches `?other&raw`", () => {
    expect(RAW_RE.test("/foo/bar.txt?other&raw")).toBe(true);
  });

  it("does NOT match ids without ?raw", () => {
    expect(RAW_RE.test("/foo/bar.txt")).toBe(false);
    expect(RAW_RE.test("/foo/bar.txt?url")).toBe(false);
    expect(RAW_RE.test("/foo/bar.txt?rawish")).toBe(false);
  });
});

describe("splitFileAndPostfix", () => {
  it("splits at the first `?`", () => {
    expect(splitFileAndPostfix("./foo.txt?raw")).toEqual(["./foo.txt", "?raw"]);
  });

  it("splits at the first `#`", () => {
    expect(splitFileAndPostfix("./foo.txt#frag")).toEqual([
      "./foo.txt",
      "#frag",
    ]);
  });

  it("returns empty postfix when no query/hash", () => {
    expect(splitFileAndPostfix("./foo.txt")).toEqual(["./foo.txt", ""]);
  });

  it("splits at whichever of `?` / `#` comes first", () => {
    expect(splitFileAndPostfix("./foo.txt#frag?raw")).toEqual([
      "./foo.txt",
      "#frag?raw",
    ]);
  });
});

/**
 * Invokes a plugin's `load` hook directly with a stubbed plugin
 * context. The handler reads through `this.fs` (rolldown's
 * plugin-context filesystem); we stub it with `node:fs/promises` so the
 * disk read works without booting a full rolldown build.
 */
async function callLoad(
  plugin: ReturnType<typeof rawPlugin>,
  id: string,
): Promise<unknown> {
  const load = plugin.load;
  if (load === undefined) throw new Error("plugin has no load hook");
  const handler = typeof load === "function" ? load : load.handler;
  return await (handler as (...args: any[]) => unknown).call(
    { fs: nodeFs } as any,
    id,
  );
}

void Bundle;
