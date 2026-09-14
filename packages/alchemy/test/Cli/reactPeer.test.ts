import { expect, it } from "alchemy-test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

type PackageManifest = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

const packageJsonPath = fileURLToPath(
  new URL("../../package.json", import.meta.url),
);

it("shares React with Sigil and consumer applications", () => {
  const manifest = JSON.parse(
    readFileSync(packageJsonPath, "utf8"),
  ) as PackageManifest;

  expect(manifest.dependencies?.react).toBeUndefined();
  expect(manifest.peerDependencies?.react).toBe(">=19.2.0");
  expect(manifest.devDependencies?.react).toBe("catalog:");
});
