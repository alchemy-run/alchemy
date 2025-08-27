import { $ } from "bun";

export async function switchVersion(version: string) {
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

if (import.meta.main) {
  await switchVersion(
    process.argv.includes("--workspace") ? "workspace:*" : "0.62.2",
  );
}
