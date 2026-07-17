import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { builtinModules } from "node:module";
import { parse as parseYaml } from "yaml";
import { ChildProcess } from "effect/unstable/process";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import { exec } from "../Util/exec.ts";
import { sha256, sha256Object } from "../Util/sha256.ts";
import { BundleError } from "./Bundle.ts";

export interface InstalledPackageFile {
  readonly path: string;
  readonly content: Uint8Array<ArrayBufferLike>;
}

type JsonRecord = Record<string, unknown>;

export type PackageInstall =
  | ReadonlyArray<string>
  | Readonly<Record<string, string>>;

export type NpmInstallRunner = (
  directory: string,
  args: ReadonlyArray<string>,
) => Effect.Effect<void, unknown>;

export interface ResolveInstallTargetsOptions {
  readonly cwd: string;
  /** Normalized package-root → requested version map (from {@link normalizeInstallTargets}). */
  readonly requested: Readonly<Record<string, string>>;
}

export interface PackageInstallIdentity {
  readonly resolved: Readonly<Record<string, string>>;
  readonly lockfile?: {
    readonly name: string;
    readonly hash: string;
  };
}

export interface HashPackageInstallIdentityOptions {
  readonly bundleHash: string;
  readonly identity: PackageInstallIdentity;
  readonly architecture: "x86_64" | "arm64";
}

export interface InstallResolvedPackagesOptions {
  /** Package-root → concrete npm version map (from {@link resolveInstallTargets}). */
  readonly resolved: Readonly<Record<string, string>>;
  readonly architecture: "x86_64" | "arm64";
  readonly runNpmInstall?: NpmInstallRunner;
}

export interface InstallPackagesOptions {
  readonly cwd: string;
  readonly install?: PackageInstall;
  readonly architecture: "x86_64" | "arm64";
  readonly runNpmInstall?: NpmInstallRunner;
}

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

const lockfileNames = [
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
] as const;

/**
 * Parses a module specifier into its package root, or `undefined` when the
 * specifier is not a bare package import (relative path, builtin, glob, subpath
 * imports, etc.).
 */
export function parsePackageRoot(specifier: string): string | undefined {
  const root = parsePackageRootFromSpecifier(specifier);
  return root === specifier ? root : undefined;
}

/**
 * Parses a bare package specifier or subpath import into its package root.
 */
export function parsePackageRootFromSpecifier(
  specifier: string,
): string | undefined {
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

/** Whether `moduleId` is `root` itself or a subpath import of it. */
export function matchesPackageRoot(moduleId: string, root: string): boolean {
  return moduleId === root || moduleId.startsWith(`${root}/`);
}

export function npmInstallArgs(
  architecture: "x86_64" | "arm64",
  _packageNames: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const npmArchitecture = architecture === "arm64" ? "arm64" : "x64";
  return [
    "install",
    "--force",
    "--platform=linux",
    "--os=linux",
    `--arch=${npmArchitecture}`,
    `--cpu=${npmArchitecture}`,
    "--libc=glibc",
  ];
}

/**
 * Normalizes and validates a `build.install` declaration to a
 * package-root → requested-version map. Array entries default to `"*"`.
 */
export function normalizeInstallTargets(
  install: PackageInstall | undefined,
): Effect.Effect<Record<string, string>, BundleError> {
  if (!install) return Effect.succeed({});
  const entries: ReadonlyArray<readonly [string, string]> = Array.isArray(
    install,
  )
    ? install.map((dep) => [dep, "*"] as const)
    : Object.entries(install);

  const requested: Record<string, string> = {};
  for (const [dep, version] of entries) {
    const root = parsePackageRoot(dep);
    if (root === undefined) {
      return Effect.fail(
        new BundleError({
          message: `Invalid package name '${dep}' in build.install. Use a package root like 'sharp', not a subpath or bare specifier.`,
        }),
      );
    }
    requested[root] = version;
  }
  return Effect.succeed(requested);
}

/**
 * Resolves the npm-compatible version for every requested package, reading the
 * nearest source `package.json` and pnpm/Bun catalogs. Does not run npm.
 */
export function resolveInstallTargets(
  options: ResolveInstallTargetsOptions,
): Effect.Effect<
  Record<string, string>,
  BundleError,
  FileSystem.FileSystem | Path.Path
> {
  const packageNames = Object.keys(options.requested).sort();
  if (packageNames.length === 0) return Effect.succeed({});

  return Effect.gen(function* () {
    const sourcePackageJson = yield* readSourcePackageJson(options.cwd);
    const resolved: Record<string, string> = {};
    for (const packageName of packageNames) {
      resolved[packageName] = yield* resolveInstallVersion(
        options.cwd,
        sourcePackageJson,
        packageName,
        options.requested[packageName],
      );
    }
    const lockfilePath = yield* findUp(options.cwd, lockfileNames);
    if (lockfilePath === undefined) {
      return resolved;
    }
    return yield* pinInstallVersionsFromLockfile({
      cwd: options.cwd,
      lockfilePath,
      packageJson: sourcePackageJson,
      requested: options.requested,
      resolved,
    });
  }).pipe(Effect.mapError(toBundleError));
}

/**
 * Resolves the package install identity used by Lambda diffing. The lockfile
 * fingerprint makes range-preserving dependency updates trigger a new artifact.
 */
export function resolvePackageInstallIdentity(
  options: ResolveInstallTargetsOptions,
): Effect.Effect<
  PackageInstallIdentity,
  BundleError,
  FileSystem.FileSystem | Path.Path
> {
  return Effect.gen(function* () {
    const resolved = yield* resolveInstallTargets(options);
    if (Object.keys(resolved).length === 0) {
      return { resolved };
    }
    const lockfile = yield* readNearestLockfileFingerprint(options.cwd);
    return { resolved, lockfile };
  });
}

export function hashPackageInstallIdentity(
  options: HashPackageInstallIdentityOptions,
): Effect.Effect<string> {
  return sha256Object({
    bundle: options.bundleHash,
    install: options.identity.resolved,
    lockfile: options.identity.lockfile,
    architecture: options.architecture,
  });
}

/**
 * Installs already-resolved dependencies into an isolated npm artifact targeting
 * Linux and the function's architecture, returning the artifact's files.
 */
export function installResolvedPackages(
  options: InstallResolvedPackagesOptions,
): Effect.Effect<
  ReadonlyArray<InstalledPackageFile>,
  BundleError,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner
> {
  const packageNames = Object.keys(options.resolved).sort();
  if (packageNames.length === 0) return Effect.succeed([]);

  const runInstall = (
    directory: string,
    args: ReadonlyArray<string>,
  ): Effect.Effect<void, BundleError, ChildProcessSpawner> =>
    options.runNpmInstall === undefined
      ? runNpmInstall(directory, args)
      : options
          .runNpmInstall(directory, args)
          .pipe(Effect.mapError(toBundleError));

  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;

    return yield* Effect.acquireUseRelease(
      fileSystem.makeTempDirectory({ prefix: "alchemy-lambda-packages-" }),
      (directory) =>
        Effect.gen(function* () {
          yield* fileSystem.writeFileString(
            pathService.join(directory, "package.json"),
            `${JSON.stringify(
              { private: true, dependencies: options.resolved },
              null,
              2,
            )}\n`,
          );
          yield* runInstall(
            directory,
            npmInstallArgs(options.architecture, packageNames),
          );
          return yield* readArtifactFiles(directory);
        }),
      (directory) =>
        fileSystem.remove(directory, { recursive: true }).pipe(Effect.ignore),
    );
  }).pipe(Effect.mapError(toBundleError));
}

/**
 * Convenience flow for callers that do not need to defer installation.
 */
export function installPackages(
  options: InstallPackagesOptions,
): Effect.Effect<
  ReadonlyArray<InstalledPackageFile>,
  BundleError,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner
> {
  return Effect.gen(function* () {
    const requested = yield* normalizeInstallTargets(options.install);
    const resolved = yield* resolveInstallTargets({
      cwd: options.cwd,
      requested,
    });
    return yield* installResolvedPackages({
      resolved,
      architecture: options.architecture,
      runNpmInstall: options.runNpmInstall,
    });
  });
}

const runNpmInstall = (
  directory: string,
  args: ReadonlyArray<string>,
): Effect.Effect<void, BundleError, ChildProcessSpawner> =>
  Effect.sync(() =>
    ChildProcess.setCwd(
      ChildProcess.make("npm", args, {
        shell: false,
        env: { ...process.env },
      }),
      directory,
    ),
  ).pipe(
    Effect.flatMap(exec),
    Effect.scoped,
    Effect.mapError((cause) => {
      const message = cause instanceof Error ? cause.message : String(cause);
      return new BundleError({
        message: message.includes("ENOENT")
          ? "Failed to run 'npm install' for build.install: 'npm' was not found on PATH. build.install shells out to npm (even in Bun/pnpm projects), so Node.js/npm must be installed."
          : `Failed to run 'npm install' for build.install: ${message}`,
        cause,
      });
    }),
    Effect.flatMap(({ exitCode, stderr }) =>
      exitCode === 0
        ? Effect.void
        : Effect.fail(
            new BundleError({
              message: `npm install for build.install failed with exit code ${exitCode}: ${stderr}`,
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

const pinInstallVersionsFromLockfile = (options: {
  readonly cwd: string;
  readonly lockfilePath: string;
  readonly packageJson: PackageJson;
  readonly requested: Readonly<Record<string, string>>;
  readonly resolved: Readonly<Record<string, string>>;
}): Effect.Effect<
  Record<string, string>,
  BundleError,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const lockfileName = path.basename(options.lockfilePath);
    const lockfileDirectory = path.dirname(options.lockfilePath);
    const importer = path
      .relative(lockfileDirectory, options.cwd)
      .replaceAll("\\", "/");
    const candidates = Object.keys(options.resolved).filter((packageName) => {
      const requested = options.requested[packageName];
      const declared = declaredPackageVersion(options.packageJson, packageName);
      return (
        declared !== undefined &&
        (requested === undefined ||
          requested === "" ||
          requested === "*" ||
          requested === declared)
      );
    });
    if (candidates.length === 0) {
      return { ...options.resolved };
    }

    const locked: Record<string, string> =
      lockfileName === "bun.lockb"
        ? {}
        : yield* Effect.gen(function* () {
            const content = yield* fs.readFileString(options.lockfilePath).pipe(
              Effect.mapError(
                (cause) =>
                  new BundleError({
                    message: `Failed to read package-manager lockfile for Lambda externals from '${options.cwd}'`,
                    cause,
                  }),
              ),
            );
            return yield* Effect.try({
              try: () =>
                parseLockedVersions({
                  name: lockfileName,
                  content,
                  importer,
                  candidates,
                  packageJson: options.packageJson,
                }),
              catch: (cause) =>
                new BundleError({
                  message: `Failed to resolve locked Lambda package versions from '${options.lockfilePath}'`,
                  cause,
                }),
            });
          });

    if (lockfileName === "bun.lock" || lockfileName === "bun.lockb") {
      for (const packageName of candidates) {
        if (locked[packageName] !== undefined) continue;
        const installedVersion = yield* findInstalledPackageVersion(
          options.cwd,
          packageName,
        );
        if (installedVersion !== undefined) {
          locked[packageName] = installedVersion;
        }
      }
    }

    for (const packageName of candidates) {
      if (locked[packageName] === undefined) {
        return yield* Effect.fail(
          new BundleError({
            message: `Could not resolve a locked version for '${packageName}' from '${options.lockfilePath}'. Pin an exact npm-compatible version in build.install or refresh the package-manager lockfile.`,
          }),
        );
      }
    }

    return { ...options.resolved, ...locked };
  });

const parseLockedVersions = (options: {
  readonly name: string;
  readonly content: string;
  readonly importer: string;
  readonly candidates: ReadonlyArray<string>;
  readonly packageJson: PackageJson;
}): Record<string, string> => {
  switch (options.name) {
    case "package-lock.json":
      return parsePackageLock(options);
    case "pnpm-lock.yaml":
      return parsePnpmLock(options);
    case "bun.lock":
      return parseBunLock(options);
    case "yarn.lock":
      return parseYarnLock(options);
    default:
      return {};
  }
};

const parsePackageLock = (options: {
  readonly content: string;
  readonly importer: string;
  readonly candidates: ReadonlyArray<string>;
  readonly packageJson: PackageJson;
}): Record<string, string> => {
  const lockfile = asRecord(JSON.parse(options.content));
  const packages = asRecord(lockfile?.packages);
  const dependencies = asRecord(lockfile?.dependencies);
  const importerKey = options.importer === "." ? "" : options.importer;
  const importer = asRecord(packages?.[importerKey]);
  const locked: Record<string, string> = {};

  for (const packageName of options.candidates) {
    const importerSpec = dependencyValue(importer, packageName);
    const declared = declaredPackageVersion(options.packageJson, packageName);
    if (
      importerSpec !== undefined &&
      declared !== undefined &&
      importerSpec !== declared
    ) {
      continue;
    }

    for (const packagePath of nodeModulesLookupPaths(
      importerKey,
      packageName,
    )) {
      const version = stringValue(asRecord(packages?.[packagePath])?.version);
      if (version !== undefined) {
        locked[packageName] = version;
        break;
      }
    }

    if (locked[packageName] === undefined && importerKey === "") {
      const version = stringValue(
        asRecord(dependencies?.[packageName])?.version,
      );
      if (version !== undefined) {
        locked[packageName] = version;
      }
    }
  }
  return locked;
};

const parsePnpmLock = (options: {
  readonly content: string;
  readonly importer: string;
  readonly candidates: ReadonlyArray<string>;
  readonly packageJson: PackageJson;
}): Record<string, string> => {
  const lockfile = asRecord(parseYaml(options.content));
  const importers = asRecord(lockfile?.importers);
  const importerKey = options.importer === "" ? "." : options.importer;
  const importer =
    asRecord(importers?.[importerKey]) ??
    (importerKey === "." ? lockfile : undefined);
  const locked: Record<string, string> = {};

  for (const packageName of options.candidates) {
    const entry = dependencyEntry(importer, packageName);
    const record = asRecord(entry);
    const specifier = stringValue(record?.specifier);
    const declared = declaredPackageVersion(options.packageJson, packageName);
    if (
      specifier !== undefined &&
      declared !== undefined &&
      specifier !== declared
    ) {
      continue;
    }
    const rawVersion =
      typeof entry === "string" ? entry : stringValue(record?.version);
    const version = normalizePnpmVersion(packageName, rawVersion);
    if (version !== undefined) {
      locked[packageName] = version;
    }
  }
  return locked;
};

const parseBunLock = (options: {
  readonly content: string;
  readonly candidates: ReadonlyArray<string>;
}): Record<string, string> => {
  const lockfile = asRecord(parseJsonc(options.content));
  const packages = asRecord(lockfile?.packages);
  const locked: Record<string, string> = {};
  if (packages === undefined) return locked;

  for (const packageName of options.candidates) {
    const direct = parseBunPackageDescriptor(packages[packageName]);
    if (direct?.name === packageName) {
      locked[packageName] = direct.version;
      continue;
    }
    const matches = Object.values(packages)
      .map(parseBunPackageDescriptor)
      .filter(
        (entry): entry is { name: string; version: string } =>
          entry?.name === packageName,
      );
    if (matches.length === 1) {
      locked[packageName] = matches[0].version;
    }
  }
  return locked;
};

const parseYarnLock = (options: {
  readonly content: string;
  readonly candidates: ReadonlyArray<string>;
  readonly packageJson: PackageJson;
}): Record<string, string> => {
  const lines = options.content.split(/\r?\n/);
  const locked: Record<string, string> = {};
  for (let index = 0; index < lines.length; index++) {
    const headerLine = lines[index];
    if (/^\s/.test(headerLine) || !headerLine.endsWith(":")) continue;
    const header = headerLine.slice(0, -1).replace(/^"|"$/g, "");
    const selectors = header
      .split(",")
      .map((selector) => selector.trim().replace(/^"|"$/g, ""));
    let version: string | undefined;
    let bodyIndex = index + 1;
    while (bodyIndex < lines.length && /^\s/.test(lines[bodyIndex])) {
      const match = /^\s+version(?::\s*|\s+)["']?([^"'\s]+)["']?/.exec(
        lines[bodyIndex],
      );
      if (match !== null) version = match[1];
      bodyIndex++;
    }
    if (version === undefined) continue;

    for (const packageName of options.candidates) {
      const specifier = declaredPackageVersion(
        options.packageJson,
        packageName,
      );
      if (specifier === undefined) continue;
      const expected = `${packageName}@${specifier}`;
      const berryExpected = `${packageName}@npm:${specifier}`;
      if (selectors.includes(expected) || selectors.includes(berryExpected)) {
        locked[packageName] = version;
      }
    }
    index = bodyIndex - 1;
  }
  return locked;
};

const dependencyEntry = (
  importer: JsonRecord | undefined,
  packageName: string,
): unknown =>
  asRecord(importer?.dependencies)?.[packageName] ??
  asRecord(importer?.optionalDependencies)?.[packageName] ??
  asRecord(importer?.devDependencies)?.[packageName];

const dependencyValue = (
  importer: JsonRecord | undefined,
  packageName: string,
): string | undefined => stringValue(dependencyEntry(importer, packageName));

const declaredPackageVersion = (
  packageJson: PackageJson,
  packageName: string,
): string | undefined =>
  packageJson.dependencies?.[packageName] ??
  packageJson.optionalDependencies?.[packageName] ??
  packageJson.devDependencies?.[packageName];

const nodeModulesLookupPaths = (
  importer: string,
  packageName: string,
): ReadonlyArray<string> => {
  const paths: string[] = [];
  let current = importer;
  while (true) {
    paths.push(
      current === ""
        ? `node_modules/${packageName}`
        : `${current}/node_modules/${packageName}`,
    );
    if (current === "") break;
    const separator = current.lastIndexOf("/");
    current = separator === -1 ? "" : current.slice(0, separator);
  }
  return paths;
};

const normalizePnpmVersion = (
  packageName: string,
  rawVersion: string | undefined,
): string | undefined => {
  if (
    rawVersion === undefined ||
    rawVersion.startsWith("link:") ||
    rawVersion.startsWith("workspace:")
  ) {
    return undefined;
  }
  let version = rawVersion.startsWith("/") ? rawVersion.slice(1) : rawVersion;
  if (version.startsWith(`${packageName}@`)) {
    version = version.slice(packageName.length + 1);
  }
  const peerSuffix = version.indexOf("(");
  return peerSuffix === -1 ? version : version.slice(0, peerSuffix);
};

const parseBunPackageDescriptor = (
  value: unknown,
): { name: string; version: string } | undefined => {
  if (!Array.isArray(value) || typeof value[0] !== "string") {
    return undefined;
  }
  const descriptor = value[0];
  const separator = descriptor.lastIndexOf("@");
  if (separator <= 0 || separator === descriptor.length - 1) {
    return undefined;
  }
  return {
    name: descriptor.slice(0, separator),
    version: descriptor.slice(separator + 1),
  };
};

const parseJsonc = (content: string): unknown => {
  let withoutComments = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < content.length; index++) {
    const char = content[index];
    const next = content[index + 1];
    if (inString) {
      withoutComments += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      withoutComments += char;
      continue;
    }
    if (char === "/" && next === "/") {
      while (index < content.length && content[index] !== "\n") index++;
      withoutComments += "\n";
      continue;
    }
    if (char === "/" && next === "*") {
      index += 2;
      while (
        index < content.length &&
        !(content[index] === "*" && content[index + 1] === "/")
      ) {
        if (content[index] === "\n") withoutComments += "\n";
        index++;
      }
      index++;
      continue;
    }
    withoutComments += char;
  }

  let withoutTrailingCommas = "";
  inString = false;
  escaped = false;
  for (let index = 0; index < withoutComments.length; index++) {
    const char = withoutComments[index];
    if (inString) {
      withoutTrailingCommas += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      withoutTrailingCommas += char;
      continue;
    }
    if (char === ",") {
      let lookahead = index + 1;
      while (/\s/.test(withoutComments[lookahead] ?? "")) lookahead++;
      if (
        withoutComments[lookahead] === "}" ||
        withoutComments[lookahead] === "]"
      ) {
        continue;
      }
    }
    withoutTrailingCommas += char;
  }
  return JSON.parse(withoutTrailingCommas);
};

const findInstalledPackageVersion = (
  cwd: string,
  packageName: string,
): Effect.Effect<
  string | undefined,
  BundleError,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    let current = cwd;
    while (true) {
      const manifestPath = path.join(
        current,
        "node_modules",
        ...packageName.split("/"),
        "package.json",
      );
      if (yield* fs.exists(manifestPath).pipe(Effect.mapError(toBundleError))) {
        const manifest = JSON.parse(
          yield* fs
            .readFileString(manifestPath)
            .pipe(Effect.mapError(toBundleError)),
        ) as { readonly version?: unknown };
        if (typeof manifest.version === "string") return manifest.version;
      }
      const parent = path.dirname(current);
      if (parent === current) return undefined;
      current = parent;
    }
  });

const asRecord = (value: unknown): JsonRecord | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;

const stringValue = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const resolveCatalogVersion = (
  cwd: string,
  packageName: string,
  version: string,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
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

const findUp = (
  cwd: string,
  filenames: ReadonlyArray<string>,
): Effect.Effect<
  string | undefined,
  BundleError,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    for (const filename of filenames) {
      const candidate = path.join(cwd, filename);
      if (yield* fs.exists(candidate).pipe(Effect.mapError(toBundleError))) {
        return candidate;
      }
    }
    const parent = path.dirname(cwd);
    if (parent === cwd) {
      return undefined;
    }
    return yield* findUp(parent, filenames);
  });

const readNearestLockfileFingerprint = (
  cwd: string,
): Effect.Effect<
  PackageInstallIdentity["lockfile"],
  BundleError,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const lockfilePath = yield* findUp(cwd, lockfileNames);
    if (lockfilePath === undefined) {
      return undefined;
    }
    const content = yield* fs.readFile(lockfilePath);
    return {
      name: path.basename(lockfilePath),
      hash: yield* sha256(content),
    };
  }).pipe(
    Effect.mapError(
      (cause) =>
        new BundleError({
          message: `Failed to read package-manager lockfile for Lambda externals from '${cwd}'`,
          cause,
        }),
    ),
  );

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
  const workspaceSource = parseBunWorkspacesCatalogSource(manifest.workspaces);
  const catalog = workspaceSource?.catalog ?? manifest.catalog;
  const catalogs =
    manifest.catalogs !== undefined || workspaceSource?.catalogs !== undefined
      ? { ...manifest.catalogs, ...workspaceSource?.catalogs }
      : undefined;
  return catalog !== undefined || catalogs !== undefined
    ? { catalog, catalogs }
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
    const files: InstalledPackageFile[] = [];
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
