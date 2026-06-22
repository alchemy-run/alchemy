import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import fg from "fast-glob";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  access,
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { runDockerCommand } from "./Docker.ts";

export class ExternalPackageError extends Data.TaggedError(
  "ExternalPackageError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const packageNamePattern =
  /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;

export const normalizeExternalPackageNames = (
  packages: readonly string[],
): Effect.Effect<string[], ExternalPackageError> =>
  Effect.gen(function* () {
    for (const packageName of packages) {
      if (!packageNamePattern.test(packageName)) {
        return yield* new ExternalPackageError({
          message: `Invalid external package name ${JSON.stringify(packageName)}. Use a package root such as "sharp" or "@scope/package".`,
        });
      }
    }
    return Array.from(new Set(packages)).sort();
  });

export const externalPackagePredicate = (packages: readonly string[]) => {
  const roots = new Set(packages);
  return (id: string) => {
    if (roots.has(id)) return true;
    for (const root of roots) {
      if (id.startsWith(`${root}/`)) return true;
    }
    return false;
  };
};

export interface ExternalPackageProject {
  readonly manager: "bun" | "npm";
  readonly packageRoot: string;
  readonly lockRoot: string;
  readonly lockfile: string;
  readonly bunVersion: string | undefined;
}

interface PackageManifest {
  readonly [key: string]: unknown;
  readonly packageManager?: string;
  readonly dependencies?: Record<string, string>;
  readonly optionalDependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
  readonly peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  readonly bundledDependencies?: readonly string[];
  readonly workspaces?:
    | readonly string[]
    | { readonly packages?: readonly string[] };
}

const exists = (file: string) =>
  access(file).then(
    () => true,
    () => false,
  );

const readManifest = async (file: string): Promise<PackageManifest> => {
  try {
    return JSON.parse(await readFile(file, "utf8")) as PackageManifest;
  } catch (cause) {
    throw new ExternalPackageError({
      message: `Failed to read package manifest ${file}`,
      cause,
    });
  }
};

const unsupportedDependencyProtocol =
  /^(?:workspace:|file:|link:|git(?:\+[^:]+)?:|github:|https?:)/;

const validateNpmRegistryPackages = async (
  lockfile: string,
  packages: readonly string[],
) => {
  const lock = JSON.parse(await readFile(lockfile, "utf8")) as {
    readonly packages?: Record<string, { readonly resolved?: string }>;
  };
  for (const packageName of packages) {
    const resolved = lock.packages?.[`node_modules/${packageName}`]?.resolved;
    if (resolved === undefined) continue;
    const host = new URL(resolved).hostname;
    if (host !== "registry.npmjs.org" && host !== "registry.yarnpkg.com") {
      throw new ExternalPackageError({
        message: `External package ${JSON.stringify(packageName)} resolves through unsupported registry ${host}. Version 1 supports the public npm registry only.`,
      });
    }
  }
};

export const discoverExternalPackageProject = (
  packageRoot: string,
  packages: readonly string[],
): Effect.Effect<ExternalPackageProject, ExternalPackageError> =>
  Effect.tryPromise({
    try: async () => {
      const normalized = await Effect.runPromise(
        normalizeExternalPackageNames(packages),
      );
      const packageManifestFile = path.join(packageRoot, "package.json");
      const packageManifest = await readManifest(packageManifestFile);

      for (const packageName of normalized) {
        const spec =
          packageManifest.dependencies?.[packageName] ??
          packageManifest.optionalDependencies?.[packageName];
        if (spec === undefined) {
          throw new ExternalPackageError({
            message: `External package ${JSON.stringify(packageName)} must be declared in dependencies or optionalDependencies of ${packageManifestFile}.`,
          });
        }
        if (unsupportedDependencyProtocol.test(spec)) {
          throw new ExternalPackageError({
            message: `External package ${JSON.stringify(packageName)} uses unsupported dependency specifier ${JSON.stringify(spec)}. Version 1 supports public registry packages only.`,
          });
        }
      }

      let current = path.resolve(packageRoot);
      while (true) {
        const bunLock = path.join(current, "bun.lock");
        const npmLock = path.join(current, "package-lock.json");
        const [hasBunLock, hasNpmLock] = await Promise.all([
          exists(bunLock),
          exists(npmLock),
        ]);
        if (hasBunLock || hasNpmLock) {
          const rootManifest = await readManifest(
            path.join(current, "package.json"),
          );
          let manager: "bun" | "npm";
          if (hasBunLock && hasNpmLock) {
            if (rootManifest.packageManager?.startsWith("bun@")) {
              manager = "bun";
            } else if (rootManifest.packageManager?.startsWith("npm@")) {
              manager = "npm";
            } else {
              throw new ExternalPackageError({
                message: `Both bun.lock and package-lock.json exist in ${current}; set packageManager to "bun@..." or "npm@...".`,
              });
            }
          } else {
            manager = hasBunLock ? "bun" : "npm";
          }
          if (manager === "npm") {
            await validateNpmRegistryPackages(npmLock, normalized);
          }
          return {
            manager,
            packageRoot: path.resolve(packageRoot),
            lockRoot: current,
            lockfile: manager === "bun" ? bunLock : npmLock,
            bunVersion: rootManifest.packageManager?.startsWith("bun@")
              ? rootManifest.packageManager.slice("bun@".length)
              : undefined,
          };
        }
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
      }

      throw new ExternalPackageError({
        message: `No bun.lock or package-lock.json found above ${packageRoot}. External Lambda packages require a frozen lockfile.`,
      });
    },
    catch: (cause) =>
      cause instanceof ExternalPackageError
        ? cause
        : new ExternalPackageError({
            message: `Failed to discover external package project for ${packageRoot}`,
            cause,
          }),
  });

export interface ExternalPackageFile {
  readonly path: string;
  readonly content: Uint8Array<ArrayBufferLike>;
  readonly mode: number;
}

export const hashExternalPackageFiles = (
  files: readonly ExternalPackageFile[],
) =>
  digest(
    [...files]
      .sort((a, b) => a.path.localeCompare(b.path))
      .flatMap((file) => [
        file.path,
        file.mode.toString(8),
        digest([file.content]),
      ]),
  );

export const hashLambdaDeploymentCode = (options: {
  readonly bundleHash: string;
  readonly externalHash: string | undefined;
  readonly runtime: "nodejs22.x" | "nodejs24.x";
  readonly architecture: "x86_64" | "arm64";
}) => {
  if (options.externalHash === undefined) return options.bundleHash;
  return digest([
    "lambda-external-deployment-code-v1",
    options.bundleHash,
    options.externalHash,
    options.runtime,
    options.architecture,
  ]);
};

export const validateLambdaPackageSize = (options: {
  readonly uncompressedSize: number;
  readonly compressedSize: number;
  readonly hasAssets: boolean;
}): Effect.Effect<void, ExternalPackageError> => {
  if (options.uncompressedSize > 250 * 1024 * 1024) {
    return Effect.fail(
      new ExternalPackageError({
        message: `Lambda deployment package is ${(options.uncompressedSize / 1024 / 1024).toFixed(2)} MiB uncompressed; AWS Lambda allows at most 250 MiB including dependencies.`,
      }),
    );
  }
  if (!options.hasAssets && options.compressedSize > 50 * 1024 * 1024) {
    return Effect.fail(
      new ExternalPackageError({
        message: `Lambda deployment package is ${(options.compressedSize / 1024 / 1024).toFixed(2)} MiB compressed and cannot be uploaded inline. Run "alchemy aws bootstrap" to configure the Assets bucket for S3 uploads.`,
      }),
    );
  }
  return Effect.void;
};

const isWithin = (root: string, candidate: string) => {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
};

const findInstalledPackage = async (
  installRoot: string,
  fromPackage: string,
  packageName: string,
) => {
  let current = fromPackage;
  while (isWithin(installRoot, current)) {
    const candidate = path.join(current, "node_modules", packageName);
    if (await exists(path.join(candidate, "package.json"))) {
      return candidate;
    }
    if (current === installRoot) break;
    current = path.dirname(current);
  }
  return undefined;
};

export const collectExternalPackageFiles = (
  nodeModulesRoot: string,
  packages: readonly string[],
): Effect.Effect<ExternalPackageFile[], ExternalPackageError> =>
  Effect.tryPromise({
    try: async () => {
      const normalized = await Effect.runPromise(
        normalizeExternalPackageNames(packages),
      );
      const installRoot = await realpath(
        path.dirname(path.resolve(nodeModulesRoot)),
      );
      const resolvedNodeModulesRoot = path.join(installRoot, "node_modules");
      const collected = new Map<string, ExternalPackageFile>();
      const visitedPackages = new Set<string>();

      const collectDirectory = async (
        source: string,
        destination: string,
        seenDirectories: Set<string>,
      ): Promise<void> => {
        const canonical = await realpath(source);
        if (!isWithin(installRoot, canonical)) {
          throw new ExternalPackageError({
            message: `External package path ${source} resolves outside the target install root.`,
          });
        }
        if (seenDirectories.has(canonical)) return;
        seenDirectories.add(canonical);
        for (const entry of await readdir(source, { withFileTypes: true })) {
          if (entry.name === "node_modules") continue;
          const sourcePath = path.join(source, entry.name);
          const destinationPath = path.posix.join(destination, entry.name);
          const info = await lstat(sourcePath);
          if (info.isSymbolicLink()) {
            const target = await realpath(sourcePath);
            if (!isWithin(installRoot, target)) {
              throw new ExternalPackageError({
                message: `External package symlink ${sourcePath} resolves outside the target install root.`,
              });
            }
            const targetInfo = await lstat(target);
            if (targetInfo.isDirectory()) {
              await collectDirectory(target, destinationPath, seenDirectories);
            } else if (targetInfo.isFile()) {
              collected.set(destinationPath, {
                path: destinationPath,
                content: await readFile(target),
                mode: targetInfo.mode & 0o111 ? 0o755 : 0o644,
              });
            }
          } else if (info.isDirectory()) {
            await collectDirectory(
              sourcePath,
              destinationPath,
              seenDirectories,
            );
          } else if (info.isFile()) {
            collected.set(destinationPath, {
              path: destinationPath,
              content: await readFile(sourcePath),
              mode: info.mode & 0o111 ? 0o755 : 0o644,
            });
          }
        }
      };

      const collectPackage = async (
        packageDirectory: string,
      ): Promise<void> => {
        const canonical = await realpath(packageDirectory);
        if (!isWithin(installRoot, canonical)) {
          throw new ExternalPackageError({
            message: `External package ${packageDirectory} resolves outside the target install root.`,
          });
        }
        if (visitedPackages.has(canonical)) return;
        visitedPackages.add(canonical);

        const relative = path.relative(installRoot, packageDirectory);
        await collectDirectory(
          packageDirectory,
          relative.split(path.sep).join(path.posix.sep),
          new Set(),
        );

        const manifest = await readManifest(
          path.join(packageDirectory, "package.json"),
        );
        const required = new Set([
          ...Object.keys(manifest.dependencies ?? {}),
          ...Object.keys(manifest.peerDependencies ?? {}).filter(
            (name) => !manifest.peerDependenciesMeta?.[name]?.optional,
          ),
          ...(manifest.bundledDependencies ?? []),
        ]);
        const optional = new Set([
          ...Object.keys(manifest.optionalDependencies ?? {}),
          ...Object.keys(manifest.peerDependencies ?? {}).filter(
            (name) => manifest.peerDependenciesMeta?.[name]?.optional,
          ),
        ]);

        for (const dependency of [...required, ...optional].sort()) {
          const installed = await findInstalledPackage(
            installRoot,
            packageDirectory,
            dependency,
          );
          if (installed) {
            await collectPackage(installed);
          } else if (required.has(dependency)) {
            throw new ExternalPackageError({
              message: `Required dependency ${JSON.stringify(dependency)} of ${packageDirectory} is missing from the target install.`,
            });
          }
        }
      };

      for (const packageName of normalized) {
        const packageDirectory = path.join(
          resolvedNodeModulesRoot,
          packageName,
        );
        if (!(await exists(path.join(packageDirectory, "package.json")))) {
          throw new ExternalPackageError({
            message: `External package ${JSON.stringify(packageName)} was not installed for the Lambda target.`,
          });
        }
        await collectPackage(packageDirectory);
      }

      return Array.from(collected.values()).sort((a, b) =>
        a.path.localeCompare(b.path),
      );
    },
    catch: (cause) =>
      cause instanceof ExternalPackageError
        ? cause
        : new ExternalPackageError({
            message: "Failed to collect external Lambda package files.",
            cause,
          }),
  });

export const renderExternalPackageDockerfile = (options: {
  readonly manager: "bun" | "npm";
  readonly runtime: "nodejs22.x" | "nodejs24.x";
  readonly packages: readonly string[];
  readonly bunVersion: string;
}) => {
  const runtimeVersion = options.runtime === "nodejs24.x" ? "24" : "22";
  const packageNames = [...options.packages].sort().join(" ");
  const bunStage =
    options.manager === "bun"
      ? [
          `FROM --platform=$TARGETPLATFORM oven/bun:${options.bunVersion} AS bun`,
          "",
        ]
      : [];
  const install =
    options.manager === "bun"
      ? [
          "COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun",
          "RUN bun install --frozen-lockfile --production --ignore-scripts --linker=hoisted",
          // `bun pm trust` cannot discover scripts after an `--ignore-scripts`
          // install, while npm can rebuild an existing Bun-installed package.
          `RUN npm rebuild --foreground-scripts ${packageNames}`,
        ]
      : [
          "RUN npm ci --omit=dev --ignore-scripts",
          `RUN npm rebuild --foreground-scripts ${packageNames}`,
        ];
  return [
    "# syntax=docker/dockerfile:1",
    ...bunStage,
    `FROM --platform=$TARGETPLATFORM public.ecr.aws/sam/build-nodejs${runtimeVersion}.x:latest AS dependencies`,
    "WORKDIR /workspace",
    "COPY . .",
    ...install,
    "",
    "FROM scratch AS export",
    "COPY --from=dependencies /workspace/node_modules /node_modules",
    "",
  ].join("\n");
};

const digest = (values: readonly (string | Uint8Array)[]) => {
  const hash = createHash("sha256");
  for (const value of values) {
    hash.update(value);
    hash.update("\0");
  }
  return hash.digest("hex");
};

const workspacePatterns = (manifest: PackageManifest): readonly string[] => {
  const workspaces = manifest.workspaces;
  if (workspaces === undefined) return [];
  if (Array.isArray(workspaces)) return workspaces;
  return (
    (workspaces as { readonly packages?: readonly string[] }).packages ?? []
  );
};

export const prepareExternalPackageBuildContext = (options: {
  readonly project: ExternalPackageProject;
  readonly packages: readonly string[];
  readonly runtime: "nodejs22.x" | "nodejs24.x";
  readonly architecture: "x86_64" | "arm64";
  readonly bunVersion: string;
  readonly directory: string;
}): Effect.Effect<
  { readonly fingerprint: string; readonly platform: string },
  ExternalPackageError
> =>
  Effect.tryPromise({
    try: async () => {
      const packages = await Effect.runPromise(
        normalizeExternalPackageNames(options.packages),
      );
      const rootManifestFile = path.join(
        options.project.lockRoot,
        "package.json",
      );
      const rootManifest = await readManifest(rootManifestFile);
      const patterns = workspacePatterns(rootManifest).map((pattern) =>
        path.posix.join(pattern.replaceAll("\\", "/"), "package.json"),
      );
      const workspaceManifests = patterns.length
        ? await fg(patterns, {
            cwd: options.project.lockRoot,
            onlyFiles: true,
            dot: true,
          })
        : [];
      const packageManifestRelative = path.relative(
        options.project.lockRoot,
        path.join(options.project.packageRoot, "package.json"),
      );
      const manifestRelatives = Array.from(
        new Set([
          "package.json",
          packageManifestRelative,
          ...workspaceManifests,
        ]),
      ).sort();
      const canonicalLockRoot = await realpath(options.project.lockRoot);

      await mkdir(options.directory, { recursive: true });
      const fingerprintInputs: Array<string | Uint8Array> = [
        "lambda-external-packages-v1",
        options.project.manager,
        options.runtime,
        options.architecture,
        options.bunVersion,
        JSON.stringify(packages),
      ];
      for (const relative of manifestRelatives) {
        const source = path.resolve(options.project.lockRoot, relative);
        const canonicalSource = await realpath(source);
        if (
          !isWithin(options.project.lockRoot, source) ||
          !isWithin(canonicalLockRoot, canonicalSource)
        ) {
          throw new ExternalPackageError({
            message: `Workspace manifest ${source} resolves outside the lockfile root.`,
          });
        }
        const raw = await readFile(source);
        fingerprintInputs.push(relative, raw);
        const manifest = JSON.parse(raw.toString("utf8")) as Record<
          string,
          unknown
        >;
        delete manifest.scripts;
        delete manifest.trustedDependencies;
        const target = path.join(options.directory, relative);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, `${JSON.stringify(manifest, null, 2)}\n`);
      }

      const lockContent = await readFile(options.project.lockfile);
      fingerprintInputs.push(
        path.basename(options.project.lockfile),
        lockContent,
      );
      await writeFile(
        path.join(options.directory, path.basename(options.project.lockfile)),
        lockContent,
      );
      await writeFile(
        path.join(options.directory, "Dockerfile"),
        renderExternalPackageDockerfile({
          manager: options.project.manager,
          runtime: options.runtime,
          packages,
          bunVersion: options.bunVersion,
        }),
      );

      return {
        fingerprint: digest(fingerprintInputs),
        platform:
          options.architecture === "arm64" ? "linux/arm64" : "linux/amd64",
      };
    },
    catch: (cause) =>
      cause instanceof ExternalPackageError
        ? cause
        : new ExternalPackageError({
            message: "Failed to prepare external Lambda package build context.",
            cause,
          }),
  });

interface ExternalPackageCacheManifest {
  readonly hash: string;
  readonly size: number;
  readonly files: ReadonlyArray<{
    readonly path: string;
    readonly mode: number;
    readonly hash: string;
    readonly size: number;
  }>;
}

const readCachedExternalPackages = async (
  cacheDirectory: string,
): Promise<{
  files: ExternalPackageFile[];
  hash: string;
  size: number;
}> => {
  const manifest = JSON.parse(
    await readFile(path.join(cacheDirectory, "manifest.json"), "utf8"),
  ) as ExternalPackageCacheManifest;
  const files: ExternalPackageFile[] = [];
  const paths = new Set<string>();
  let size = 0;
  for (const entry of manifest.files) {
    if (
      !entry.path.startsWith("node_modules/") ||
      path.posix.normalize(entry.path) !== entry.path ||
      entry.path.includes("\\") ||
      paths.has(entry.path) ||
      (entry.mode !== 0o644 && entry.mode !== 0o755)
    ) {
      throw new Error(`Unsafe cached external package path ${entry.path}`);
    }
    paths.add(entry.path);
    const content = await readFile(
      path.join(cacheDirectory, "files", ...entry.path.split("/")),
    );
    if (digest([content]) !== entry.hash) {
      throw new Error(`Corrupt cached external package file ${entry.path}`);
    }
    files.push({ path: entry.path, content, mode: entry.mode });
    size += content.byteLength;
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  if (hashExternalPackageFiles(files) !== manifest.hash) {
    throw new Error("Corrupt external package cache manifest");
  }
  if (size !== manifest.size) {
    throw new Error("Corrupt external package cache size");
  }
  return { files, hash: manifest.hash, size };
};

const writeExternalPackageCache = async (
  cacheDirectory: string,
  files: readonly ExternalPackageFile[],
) => {
  const manifest: ExternalPackageCacheManifest = {
    hash: hashExternalPackageFiles(files),
    size: files.reduce((total, file) => total + file.content.byteLength, 0),
    files: files.map((file) => ({
      path: file.path,
      mode: file.mode,
      hash: digest([file.content]),
      size: file.content.byteLength,
    })),
  };
  for (const file of files) {
    const target = path.join(cacheDirectory, "files", ...file.path.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file.content);
    await chmod(target, file.mode);
  }
  await writeFile(
    path.join(cacheDirectory, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return manifest;
};

export interface MaterializedExternalPackages {
  readonly files: ExternalPackageFile[];
  readonly hash: string;
  readonly size: number;
  readonly cacheHit: boolean;
}

const installedBunVersion = Effect.tryPromise({
  try: () =>
    new Promise<string>((resolve, reject) => {
      execFile("bun", ["--version"], (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout.trim());
      });
    }),
  catch: (cause) =>
    new ExternalPackageError({
      message: "Failed to determine the installed Bun version.",
      cause,
    }),
});

const bunVersionPattern = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

export const materializeExternalPackages = Effect.fnUntraced(
  function* (options: {
    readonly packageRoot: string;
    readonly packages: readonly string[];
    readonly runtime: "nodejs22.x" | "nodejs24.x";
    readonly architecture: "x86_64" | "arm64";
    readonly cacheDirectory: string;
    readonly bunVersion: string | undefined;
    readonly note?: (message: string) => Effect.Effect<void>;
  }) {
    const packages = yield* normalizeExternalPackageNames(options.packages);
    const project = yield* discoverExternalPackageProject(
      options.packageRoot,
      packages,
    );
    let bunVersion = options.bunVersion;
    if (project.manager === "bun" && bunVersion === undefined) {
      bunVersion = yield* installedBunVersion.pipe(
        Effect.catch(() => Effect.succeed(project.bunVersion)),
      );
    }
    if (
      project.manager === "bun" &&
      (bunVersion === undefined || !bunVersionPattern.test(bunVersion))
    ) {
      return yield* new ExternalPackageError({
        message: `Unable to select a safe Bun version for Lambda dependency packaging${bunVersion ? `: ${JSON.stringify(bunVersion)}` : "."}`,
      });
    }
    bunVersion ??= "not-used";

    yield* Effect.tryPromise({
      try: () => mkdir(options.cacheDirectory, { recursive: true }),
      catch: (cause) =>
        new ExternalPackageError({
          message: `Failed to create external package cache ${options.cacheDirectory}`,
          cause,
        }),
    });

    return yield* Effect.acquireUseRelease(
      Effect.tryPromise({
        try: () => mkdtemp(path.join(options.cacheDirectory, "build-")),
        catch: (cause) =>
          new ExternalPackageError({
            message: "Failed to create external package build directory.",
            cause,
          }),
      }),
      (temporaryDirectory) =>
        Effect.gen(function* () {
          const contextDirectory = path.join(temporaryDirectory, "context");
          const prepared = yield* prepareExternalPackageBuildContext({
            project,
            packages,
            runtime: options.runtime,
            architecture: options.architecture,
            bunVersion,
            directory: contextDirectory,
          });
          const cacheDirectory = path.join(
            options.cacheDirectory,
            prepared.fingerprint,
          );

          const cached = yield* Effect.tryPromise({
            try: () => readCachedExternalPackages(cacheDirectory),
            catch: (cause) => cause,
          }).pipe(Effect.catch(() => Effect.succeed(undefined)));
          if (cached) {
            if (options.note) {
              yield* options.note(
                `Using cached Lambda packages: ${packages.join(", ")}`,
              );
            }
            return { ...cached, cacheHit: true };
          }

          yield* Effect.tryPromise({
            try: () => rm(cacheDirectory, { recursive: true, force: true }),
            catch: (cause) =>
              new ExternalPackageError({
                message: "Failed to remove an invalid Lambda package cache.",
                cause,
              }),
          });

          if (options.note) {
            yield* options.note(
              `Installing Lambda packages for ${prepared.platform}: ${packages.join(", ")}`,
            );
          }
          const outputDirectory = path.join(temporaryDirectory, "output");
          yield* Effect.tryPromise({
            try: () => mkdir(outputDirectory, { recursive: true }),
            catch: (cause) =>
              new ExternalPackageError({
                message: "Failed to create Docker package output directory.",
                cause,
              }),
          });
          yield* runDockerCommand(
            [
              "build",
              "--platform",
              prepared.platform,
              "--target",
              "export",
              "--output",
              `type=local,dest=${outputDirectory}`,
              contextDirectory,
            ],
            { env: { DOCKER_BUILDKIT: "1" } },
          ).pipe(
            Effect.mapError(
              (cause) =>
                new ExternalPackageError({
                  message:
                    "Failed to build external Lambda packages with Docker. Ensure Docker with BuildKit and the target architecture emulator are available.",
                  cause,
                }),
            ),
            Effect.tapError((error) =>
              options.note
                ? options.note(
                    `Lambda package installation failed: ${error.message}`,
                  )
                : Effect.void,
            ),
          );

          const files = yield* collectExternalPackageFiles(
            path.join(outputDirectory, "node_modules"),
            packages,
          );
          const stagingCache = path.join(
            options.cacheDirectory,
            `.staging-${prepared.fingerprint}-${randomUUID()}`,
          );
          const manifest = yield* Effect.tryPromise({
            try: () => writeExternalPackageCache(stagingCache, files),
            catch: (cause) =>
              new ExternalPackageError({
                message: "Failed to write external Lambda package cache.",
                cause,
              }),
          });
          yield* Effect.tryPromise({
            try: async () => {
              try {
                await rename(stagingCache, cacheDirectory);
              } catch (cause) {
                if (!(await exists(cacheDirectory))) {
                  throw cause;
                }
                await rm(stagingCache, { recursive: true, force: true });
              }
            },
            catch: (cause) =>
              new ExternalPackageError({
                message: "Failed to publish external Lambda package cache.",
                cause,
              }),
          });
          return {
            files,
            hash: manifest.hash,
            size: manifest.size,
            cacheHit: false,
          } satisfies MaterializedExternalPackages;
        }),
      (temporaryDirectory) =>
        Effect.tryPromise(() =>
          rm(temporaryDirectory, { recursive: true, force: true }),
        ).pipe(Effect.ignore),
    );
  },
);
