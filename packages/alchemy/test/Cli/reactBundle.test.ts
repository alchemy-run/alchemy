import { expect, it } from "alchemy-test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

type PackageManifest = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

const packageDir = fileURLToPath(new URL("../..", import.meta.url));
const manifest = JSON.parse(
  readFileSync(`${packageDir}/package.json`, "utf8"),
) as PackageManifest;

it("does not expose the CLI's React runtime to consumers", () => {
  expect(manifest.dependencies?.react).toBeUndefined();
  expect(manifest.peerDependencies?.react).toBeUndefined();
  expect(manifest.devDependencies?.react).toBe("catalog:");
});
