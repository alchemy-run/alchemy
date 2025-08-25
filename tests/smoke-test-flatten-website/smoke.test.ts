import { $ } from "bun";

// switch to the stable version of alchemy prior to flattening the website resource
await switchVersion("0.62.2");
await $`bun alchemy destroy`;
await $`RUN_COUNT=0 bun alchemy deploy`;

// switch to the `this` version of alchemy and ensure it deploys
await switchVersion("workspace:*");
await $`RUN_COUNT=1 bun alchemy deploy`;
// await $`bun alchemy destroy`;

async function switchVersion(version: string) {
  const rootPkgJson = Bun.file("../../package.json");
  const rootPkgJsonContent = await rootPkgJson.json();
  let workspacePackages: string[] = rootPkgJsonContent.workspaces.packages;
  if (version === "workspace:*") {
    workspacePackages.push("tests/*");
  } else {
    workspacePackages = workspacePackages.filter(
      (pkg: string) => pkg !== "tests/*",
    );
  }
  rootPkgJsonContent.workspaces.packages = workspacePackages;
  await rootPkgJson.write(JSON.stringify(rootPkgJsonContent, null, 2));
  const pkgJson = Bun.file("package.json");
  const pkgJsonContent = await pkgJson.json();
  pkgJsonContent.devDependencies.alchemy = version;
  await pkgJson.write(JSON.stringify(pkgJsonContent, null, 2));
  await $`rm -rf node_modules`;
  await $`bun i`;
}

