import { SIDECAR_ENTRY_URL } from "@/Local/RpcProviderProxy.ts";
import { expect, it } from "alchemy-test";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { rolldown } from "rolldown";
import { nodePath } from "../nodeProbe.ts";

it("resolves the source sidecar under Bun", () => {
  expect(SIDECAR_ENTRY_URL).toBe(
    new URL("../../src/Local/Sidecar.ts", import.meta.url).href,
  );
});

it.skipIf(!nodePath)(
  "resolves the published sidecar from a relocated bundle",
  async () => {
    const directory = realpathSync(
      mkdtempSync(join(tmpdir(), "alchemy-sidecar-bundle-")),
    );
    try {
      symlinkSync(
        fileURLToPath(new URL("../../node_modules", import.meta.url)),
        join(directory, "node_modules"),
        "dir",
      );
      // Model the published package layout without relying on built lib files.
      mkdirSync(join(directory, "bin"));
      mkdirSync(join(directory, "lib", "Local"), { recursive: true });
      writeFileSync(
        join(directory, "package.json"),
        JSON.stringify({
          name: "alchemy",
          type: "module",
          exports: { "./*": { import: "./lib/*.js" } },
        }),
      );
      writeFileSync(join(directory, "lib", "Local", "Sidecar.js"), "");
      const source = fileURLToPath(
        new URL("../../src/Local/RpcProviderProxy.ts", import.meta.url),
      );
      const entry = join(directory, "probe.ts");
      writeFileSync(
        entry,
        `import { SIDECAR_ENTRY_URL } from ${JSON.stringify(source)};
       await import(SIDECAR_ENTRY_URL);
       console.log(SIDECAR_ENTRY_URL);`,
      );
      const bundle = await rolldown({
        input: entry,
        external: (id) => !id.startsWith(".") && !isAbsolute(id),
        treeshake: { moduleSideEffects: false },
      });
      const output = join(directory, "bin", "exec.js");
      try {
        await bundle.write({ file: output, format: "esm" });
      } finally {
        await bundle.close();
      }
      const result = spawnSync(nodePath!, [output], {
        encoding: "utf8",
        timeout: 10_000,
      });
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe(
        pathToFileURL(join(directory, "lib", "Local", "Sidecar.js")).href,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
