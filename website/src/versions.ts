import {
  cloudflareStateStoreDependencyGroup,
  combineDependencyGroups,
  coreDependencyGroup,
  dependencyGroups,
  dependencyGroupsByImportSurface,
  type DependencyPackageName,
} from "alchemy/ProviderDependencies";
import rootPkg from "../../package.json";
import alchemyPkg from "../../packages/alchemy/package.json";

export const alchemyVersion = alchemyPkg.version;
export const effectVersion = rootPkg.workspaces.catalog.effect;

const versionSources: ReadonlyArray<Record<string, string>> = [
  rootPkg.workspaces.catalog,
  alchemyPkg.peerDependencies,
  alchemyPkg.dependencies,
  alchemyPkg.devDependencies,
];

const getPackageVersion = (name: DependencyPackageName) => {
  if (name === "alchemy") return alchemyVersion;
  for (const source of versionSources) {
    const version = source[name];
    if (version !== undefined) return version;
  }
  throw new Error(`No package version is recorded for ${name}`);
};

export const formatPackageList = (packages: readonly DependencyPackageName[]) =>
  packages.map((name) => `"${name}@${getPackageVersion(name)}"`).join(" ");

export const corePkgs = formatPackageList(coreDependencyGroup.packages);
export const awsPkgs = formatPackageList(dependencyGroups.aws.packages);
export const cloudflarePkgs = formatPackageList(
  cloudflareStateStoreDependencyGroup.packages,
);
export const gettingStartedPkgs = formatPackageList(
  combineDependencyGroups([
    coreDependencyGroup,
    cloudflareStateStoreDependencyGroup,
  ]),
);
export const awsTutorialPkgs = formatPackageList(
  combineDependencyGroups([coreDependencyGroup, dependencyGroups.aws]),
);

export const dependencyRows = dependencyGroupsByImportSurface.map(
  ({ importSurface, group }) => ({
    importSurface,
    packages: group.packages.join(", "),
  }),
);
