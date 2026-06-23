import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as fs from "node:fs/promises";
import { builtinModules } from "node:module";
import * as path from "node:path";
import type * as rolldown from "rolldown";
import { ChildProcess } from "effect/unstable/process";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import { exec } from "../Util/exec.ts";
import { BundleError } from "./Bundle.ts";

export interface ExternalPackageFile {
  readonly path: string;
  readonly content: Uint8Array<ArrayBufferLike>;
}

export interface ExternalPackageInstallOptions {
  readonly cwd: string;
  readonly external: rolldown.ExternalOption | undefined;
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
}

const builtins = new Set(
  builtinModules.flatMap((name) => [name, `node:${name}`]),
);

/**
 * Installs string-valued Rolldown externals into an isolated, Lambda-targeted
 * npm artifact and returns every generated file for inclusion in the ZIP.
 */
export function installExternalPackages(
  options: ExternalPackageInstallOptions,
): Effect.Effect<
  ReadonlyArray<ExternalPackageFile>,
  BundleError,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner
> {
  const packageNames = externalPackageNames(options.external);
  if (packageNames.length === 0) return Effect.succeed([]);

  const program = Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const sourcePackageJson = yield* readSourcePackageJson(options.cwd);
    const dependencies = yield* Effect.try({
      try: () =>
        Object.fromEntries(
          packageNames.map((packageName) => [
            packageName,
            resolvePackageVersion(sourcePackageJson, packageName),
          ]),
        ),
      catch: toBundleError,
    });

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

export function externalPackageNames(
  external: rolldown.ExternalOption | undefined,
): ReadonlyArray<string> {
  const entries = Array.isArray(external)
    ? external
    : typeof external === "string"
      ? [external]
      : [];
  const names = new Set<string>();

  for (const entry of entries) {
    if (typeof entry !== "string") continue;
    const packageName = packageNameFromSpecifier(entry);
    if (packageName !== undefined) names.add(packageName);
  }

  return [...names].sort();
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

function packageNameFromSpecifier(specifier: string): string | undefined {
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
    return segments.length >= 2 ? `${segments[0]}/${segments[1]}` : undefined;
  }
  return segments[0];
}

const readSourcePackageJson = (cwd: string) =>
  Effect.tryPromise({
    try: async () =>
      JSON.parse(
        await fs.readFile(path.join(cwd, "package.json"), "utf8"),
      ) as PackageJson,
    catch: (cause) =>
      new BundleError({
        message: `Failed to read package.json for Lambda externals from '${cwd}'`,
        cause,
      }),
  });

function resolvePackageVersion(
  packageJson: PackageJson,
  packageName: string,
): string {
  const version =
    packageJson.dependencies?.[packageName] ??
    packageJson.optionalDependencies?.[packageName] ??
    packageJson.devDependencies?.[packageName] ??
    "*";

  for (const prefix of [
    "catalog:",
    "workspace:",
    "file:",
    "link:",
    "portal:",
    "patch:",
  ]) {
    if (version.startsWith(prefix)) {
      throw new BundleError({
        message: `External package '${packageName}' uses '${version}', which cannot be installed in an isolated Lambda artifact. Pin an npm-compatible version in package.json.`,
      });
    }
  }

  return version;
}

const readArtifactFiles = (directory: string) =>
  Effect.tryPromise({
    try: async () => {
      const files: ExternalPackageFile[] = [];
      await collectDirectory(directory, "", files, new Set());
      return files.sort((a, b) => a.path.localeCompare(b.path));
    },
    catch: (cause) =>
      new BundleError({
        message: "Failed to read installed Lambda external packages",
        cause,
      }),
  });

async function collectDirectory(
  sourceDirectory: string,
  archiveDirectory: string,
  files: ExternalPackageFile[],
  ancestors: ReadonlySet<string>,
): Promise<void> {
  const realDirectory = await fs.realpath(sourceDirectory);
  if (ancestors.has(realDirectory)) return;

  const nextAncestors = new Set(ancestors);
  nextAncestors.add(realDirectory);
  const entries = await fs.readdir(realDirectory, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    const source = path.join(realDirectory, entry.name);
    const archivePath = path.posix.join(archiveDirectory, entry.name);
    const stats = entry.isSymbolicLink() ? await fs.stat(source) : undefined;

    if (entry.isDirectory() || stats?.isDirectory()) {
      await collectDirectory(source, archivePath, files, nextAncestors);
    } else if (entry.isFile() || stats?.isFile()) {
      files.push({ path: archivePath, content: await fs.readFile(source) });
    }
  }
}

function toBundleError(cause: unknown): BundleError {
  return cause instanceof BundleError
    ? cause
    : new BundleError({
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      });
}
