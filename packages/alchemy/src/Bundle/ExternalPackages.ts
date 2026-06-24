import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { builtinModules } from "node:module";
import { parse as parseYaml } from "yaml";
import { ChildProcess } from "effect/unstable/process";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import { exec } from "../Util/exec.ts";
import { BundleError } from "./Bundle.ts";

export interface ExternalPackageFile {
  readonly path: string;
  readonly content: Uint8Array<ArrayBufferLike>;
}

/**
 * Packages that must stay external during bundling because they ship native
 * binaries. Matches SST's `forceExternal` list.
 */
export const FORCE_EXTERNAL_PACKAGES = ["sharp", "pg-native"] as const;

export type ExternalPackageInstall =
  | ReadonlyArray<string>
  | ReadonlyRecord<string, string>;

export interface ExternalPackageInstallOptions {
  readonly cwd: string;
  readonly install?: ExternalPackageInstall;
  readonly architecture: "x86_64" | "arm64";
  readonly runNpmInstall?: NpmInstallRunner;
}

export type NpmInstallRunner = (
  directory: string,
  args: ReadonlyArray<string>,
) => Effect.Effect<void, unknown>;

interface PackageJson {
  readonly dependencies?: Record<string, string>;
  readonly optionalDependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
  readonly catalog?: Record<string, string>;
  readonly catalogs?: Record<string, Record<string, string>>;
  readonly workspaces?: unknown;
}

interface CatalogSource {
  readonly catalog?: Record<string, string>;
  readonly catalogs?: Record<string, Record<string, string>>;
}

const builtins = new Set(
  builtinModules.flatMap((name) => [name, `node:${name}`]),
);

const incompatibleVersionPrefixes = [
  "workspace:",
  "file:",
  "link:",
  "portal:",
  "patch:",
] as const;

/**
 * Installs packages declared via `install` into an isolated, Lambda-targeted
 * npm artifact.
 */
export function installExternalPackages(
  options: ExternalPackageInstallOptions,
): Effect.Effect<
  ReadonlyArray<ExternalPackageFile>,
  BundleError,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner
> {
  const installMap = normalizeInstallPackages(options.install);
  const packageNames = Object.keys(installMap).sort();
  if (packageNames.length === 0) return Effect.succeed([]);

  const program = Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const sourcePackageJson = yield* readSourcePackageJson(options.cwd);
    const dependencies: Record<string, string> = {};
    for (const packageName of packageNames) {
      dependencies[packageName] = yield* resolveInstallVersion(
        options.cwd,
        sourcePackageJson,
        packageName,
        installMap[packageName],
      );
    }

    return yield* Effect.acquireUseRelease(
      fileSystem.makeTempDirectory({ prefix: "alchemy-lambda-packages-" }),
      (directory) =>
        Effect.gen(function* () {
          yield* fileSystem.writeFileString(
            pathService.join(directory, "package.json"),
            `${JSON.stringify({ private: true, dependencies }, null, 2)}\n`,
          );

          const args = npmInstallArgs(options.architecture, packageNames);
          yield* options.runNpmInstall === undefined
            ? runNpmInstall(directory, args)
            : options.runNpmInstall(directory, args);
          return yield* readArtifactFiles(directory);
        }),
      (directory) =>
        fileSystem.remove(directory, { recursive: true }).pipe(Effect.ignore),
    );
  });

  return program.pipe(Effect.mapError(toBundleError));
}

export function normalizeInstallPackages(
  install: ExternalPackageInstall | undefined,
): Record<string, string> {
  if (!install) return {};
  if (Array.isArray(install)) {
    return Object.fromEntries(
      install.map((dep) => [requirePackageRoot(dep, "build.install"), "*"]),
    );
  }
  return Object.fromEntries(
    Object.entries(install).map(([dep, version]) => [
      requirePackageRoot(dep, "build.install"),
      version,
    ]),
  );
}

export function isForceExternalModule(moduleId: string): boolean {
  return FORCE_EXTERNAL_PACKAGES.some(
    (pkg) => moduleId === pkg || moduleId.startsWith(`${pkg}/`),
  );
}

export function isInstallExternalModule(
  moduleId: string,
  install: ExternalPackageInstall | undefined,
): boolean {
  if (isForceExternalModule(moduleId)) return true;
  return Object.keys(normalizeInstallPackages(install)).some(
    (pkg) => moduleId === pkg || moduleId.startsWith(`${pkg}/`),
  );
}

export function installExternalEntries(
  install: ExternalPackageInstall | undefined,
): ReadonlyArray<string> {
  return [
    ...new Set([
      ...FORCE_EXTERNAL_PACKAGES,
      ...Object.keys(normalizeInstallPackages(install)),
    ]),
  ];
}

export function npmInstallArgs(
  architecture: "x86_64" | "arm64",
  packageNames: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const npmArchitecture = architecture === "arm64" ? "arm64" : "x64";
  return [
    "install",
    "--force",
    "--platform=linux",
    "--os=linux",
    `--arch=${npmArchitecture}`,
    `--cpu=${npmArchitecture}`,
    ...(packageNames.includes("sharp") ? ["--libc=glibc"] : []),
  ];
}

export function parsePackageRoot(specifier: string): string | undefined {
  if (
    specifier.length === 0 ||
    builtins.has(specifier) ||
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    specifier.startsWith("\\") ||
    specifier.includes("*") ||
    specifier.includes("?") ||
    specifier.includes(":") ||
    specifier.includes("\0")
  ) {
    return undefined;
  }

  const segments = specifier.split("/");
  if (specifier.startsWith("@")) {
    return segments.length === 2 ? `${segments[0]}/${segments[1]}` : undefined;
  }
  return segments.length === 1 ? segments[0] : undefined;
}

function requirePackageRoot(specifier: string, context: string): string {
  const packageName = parsePackageRoot(specifier);
  if (packageName === undefined) {
    throw new BundleError({
      message: `Invalid package name '${specifier}' in ${context}. Use a package root like 'sharp', not a subpath or bare specifier.`,
    });
  }
  return packageName;
}

const runNpmInstall = (directory: string, args: ReadonlyArray<string>) =>
  exec(
    ChildProcess.setCwd(
      ChildProcess.make("npm", args, {
        shell: false,
        env: { ...process.env },
      }),
      directory,
    ),
  ).pipe(
    Effect.scoped,
    Effect.mapError(toBundleError),
    Effect.flatMap(({ exitCode, stderr }) =>
      exitCode === 0
        ? Effect.void
        : Effect.fail(
            new BundleError({
              message: `npm install failed with exit code ${exitCode}: ${stderr}`,
            }),
          ),
    ),
  );

const readSourcePackageJson = (cwd: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const content = yield* fs.readFileString(path.join(cwd, "package.json"));
    return JSON.parse(content) as PackageJson;
  }).pipe(
    Effect.mapError(
      (cause) =>
        new BundleError({
          message: `Failed to read package.json for Lambda externals from '${cwd}'`,
          cause,
        }),
    ),
  );

const resolveInstallVersion = (
  cwd: string,
  packageJson: PackageJson,
  packageName: string,
  installVersion: string | undefined,
) =>
  Effect.gen(function* () {
    let version = installVersion;
    if (version === undefined || version === "" || version === "*") {
      version =
        packageJson.dependencies?.[packageName] ??
        packageJson.optionalDependencies?.[packageName] ??
        packageJson.devDependencies?.[packageName] ??
        "*";
    }

    if (version.startsWith("catalog:")) {
      return yield* resolveCatalogVersion(cwd, packageName, version);
    }

    for (const prefix of incompatibleVersionPrefixes) {
      if (version.startsWith(prefix)) {
        return yield* Effect.fail(
          new BundleError({
            message: `External package '${packageName}' uses '${version}', which cannot be installed in an isolated Lambda artifact. Pin an npm-compatible version in package.json or build.install.`,
          }),
        );
      }
    }

    return version;
  });

const resolveCatalogVersion = (
  cwd: string,
  packageName: string,
  version: string,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const workspacePath = yield* findUp(cwd, ["pnpm-workspace.yaml"]);
    if (workspacePath !== undefined) {
      const content = yield* fs.readFileString(workspacePath);
      const workspace = parseYaml(content) as CatalogSource;
      const resolved = resolveCatalogEntry(packageName, version, workspace);
      if (resolved === undefined) {
        return yield* Effect.fail(
          new BundleError({
            message: `Could not resolve catalog version for '${packageName}' (${version}) from ${workspacePath}. Pin an npm-compatible version explicitly.`,
          }),
        );
      }
      return resolved;
    }

    const bunResolved = yield* resolveBunCatalogVersion(
      cwd,
      packageName,
      version,
    );
    if (bunResolved !== undefined) {
      return bunResolved;
    }

    return yield* Effect.fail(
      new BundleError({
        message: `Could not resolve catalog version for '${packageName}' (${version}): no pnpm-workspace.yaml or Bun catalog found. Pin an npm-compatible version explicitly.`,
      }),
    );
  });

const findUp = Effect.fn(function* (
  cwd: string,
  filenames: ReadonlyArray<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (const filename of filenames) {
    const candidate = path.join(cwd, filename);
    if (yield* fs.exists(candidate)) {
      return candidate;
    }
  }
  const parent = path.dirname(cwd);
  if (parent === cwd) {
    return undefined;
  }
  return yield* findUp(parent, filenames);
});

const resolveBunCatalogVersion = (
  cwd: string,
  packageName: string,
  version: string,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    let currentDir = cwd;
    while (true) {
      const packagePath = path.join(currentDir, "package.json");
      if (yield* fs.exists(packagePath)) {
        const content = yield* fs.readFileString(packagePath);
        const manifest = JSON.parse(content) as PackageJson;
        const source = parseBunCatalogSource(manifest);
        if (source !== undefined) {
          const resolved = resolveCatalogEntry(packageName, version, source);
          if (resolved === undefined) {
            return yield* Effect.fail(
              new BundleError({
                message: `Could not resolve catalog version for '${packageName}' (${version}) from ${packagePath}. Pin an npm-compatible version explicitly.`,
              }),
            );
          }
          return resolved;
        }
      }

      const parent = path.dirname(currentDir);
      if (parent === currentDir) {
        return undefined;
      }
      currentDir = parent;
    }
  });

const parseBunCatalogSource = (
  manifest: PackageJson,
): CatalogSource | undefined => {
  const source: CatalogSource = {
    catalog: manifest.catalog,
    catalogs: manifest.catalogs ? { ...manifest.catalogs } : undefined,
  };
  const workspaceSource = parseBunWorkspacesCatalogSource(manifest.workspaces);
  if (workspaceSource !== undefined) {
    if (workspaceSource.catalog !== undefined) {
      source.catalog = workspaceSource.catalog;
    }
    if (workspaceSource.catalogs !== undefined) {
      source.catalogs = { ...source.catalogs, ...workspaceSource.catalogs };
    }
  }
  return source.catalog !== undefined || source.catalogs !== undefined
    ? source
    : undefined;
};

const parseBunWorkspacesCatalogSource = (
  workspaces: unknown,
): CatalogSource | undefined => {
  if (
    typeof workspaces !== "object" ||
    workspaces === null ||
    Array.isArray(workspaces)
  ) {
    return undefined;
  }
  const record = workspaces as PackageJson;
  if (record.catalog === undefined && record.catalogs === undefined) {
    return undefined;
  }
  return {
    catalog: record.catalog,
    catalogs: record.catalogs,
  };
};

const resolveCatalogEntry = (
  packageName: string,
  version: string,
  source: CatalogSource,
): string | undefined => {
  const catalogName = version.slice("catalog:".length).trim();
  let catalog: Record<string, string> | undefined;
  if (catalogName === "" || catalogName === "default") {
    catalog = source.catalog ?? source.catalogs?.default;
  } else {
    catalog = source.catalogs?.[catalogName];
  }
  return catalog?.[packageName];
};

const readArtifactFiles = (directory: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const relativePaths = yield* fs.readDirectory(directory, {
      recursive: true,
    });
    const files: ExternalPackageFile[] = [];
    for (const relativePath of [...relativePaths].sort((a, b) =>
      a.localeCompare(b),
    )) {
      const absolutePath = path.join(directory, relativePath);
      const stat = yield* fs.stat(absolutePath);
      if (stat.type !== "File") continue;
      files.push({
        path: relativePath.replaceAll("\\", "/"),
        content: yield* fs.readFile(absolutePath),
      });
    }
    return files;
  }).pipe(
    Effect.mapError(
      (cause) =>
        new BundleError({
          message: "Failed to read installed Lambda external packages",
          cause,
        }),
    ),
  );

function toBundleError(cause: unknown): BundleError {
  return cause instanceof BundleError
    ? cause
    : new BundleError({
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      });
}
