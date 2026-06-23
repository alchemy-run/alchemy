import { runDockerCommand } from "@/Bundle/Docker";
import {
  collectExternalPackageFiles,
  discoverExternalPackageProject,
  externalPackagePredicate,
  hashExternalPackageFiles,
  hashLambdaDeploymentCode,
  materializeExternalPackages,
  normalizeExternalPackageNames,
  prepareExternalPackageBuildContext,
  renderExternalPackageCollector,
  renderExternalPackageDockerfile,
  validateLambdaPackageSize,
} from "@/Bundle/ExternalPackages";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { spawnSync } from "node:child_process";
import {
  access,
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const dockerIntegrationEnabled =
  process.env.ALCHEMY_TEST_LAMBDA_EXTERNAL_PACKAGES === "1" &&
  spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
const fixtureRoot = fileURLToPath(new URL("./fixtures", import.meta.url));

describe("external Lambda packages", () => {
  it("accepts package roots, removes duplicates, and externalizes subpaths", async () => {
    const packages = await Effect.runPromise(
      normalizeExternalPackageNames(["sharp", "@img/tool", "sharp"]),
    );

    expect(packages).toEqual(["@img/tool", "sharp"]);

    const isExternal = externalPackagePredicate(packages);
    expect(isExternal("sharp")).toBe(true);
    expect(isExternal("sharp/lib/index.js")).toBe(true);
    expect(isExternal("@img/tool/subpath")).toBe(true);
    expect(isExternal("sharpish")).toBe(false);
  });

  it("rejects versions and package subpaths", async () => {
    for (const name of ["sharp@1.0.0", "sharp/lib", "@img/tool/subpath"]) {
      const result = await Effect.runPromise(
        Effect.result(normalizeExternalPackageNames([name])),
      );
      expect(Result.isFailure(result)).toBe(true);
    }
  });

  it("discovers a Bun workspace and validates runtime dependencies", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "alchemy-external-"));
    try {
      const workspace = path.join(root, "packages", "app");
      await mkdir(workspace, { recursive: true });
      await writeFile(
        path.join(root, "package.json"),
        JSON.stringify({
          workspaces: ["packages/*"],
          packageManager: "bun@1.3.14",
        }),
      );
      await writeFile(path.join(root, "bun.lock"), "{}\n");
      await writeFile(
        path.join(root, ".npmrc"),
        "//registry.npmjs.org/:_authToken=secret\n",
      );
      await writeFile(
        path.join(workspace, "package.json"),
        JSON.stringify({ dependencies: { sharp: "0.34.5" } }),
      );

      const project = await Effect.runPromise(
        discoverExternalPackageProject(workspace, ["sharp"]),
      );
      expect(project.manager).toBe("bun");
      expect(project.lockRoot).toBe(root);
      expect(project.packageRoot).toBe(workspace);

      const missing = await Effect.runPromise(
        Effect.result(
          discoverExternalPackageProject(workspace, ["ffmpeg-static"]),
        ),
      );
      expect(Result.isFailure(missing)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resolves ambiguous locks with packageManager and rejects remote specs", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "alchemy-external-locks-"));
    try {
      await writeFile(
        path.join(root, "package.json"),
        JSON.stringify({ dependencies: { sharp: "0.34.5" } }),
      );
      await writeFile(path.join(root, "bun.lock"), "{}\n");
      await writeFile(path.join(root, "package-lock.json"), "{}\n");

      const ambiguous = await Effect.runPromise(
        Effect.result(discoverExternalPackageProject(root, ["sharp"])),
      );
      expect(Result.isFailure(ambiguous)).toBe(true);

      await writeFile(
        path.join(root, "package.json"),
        JSON.stringify({
          packageManager: "npm@11.0.0",
          dependencies: { sharp: "0.34.5" },
        }),
      );
      const npmProject = await Effect.runPromise(
        discoverExternalPackageProject(root, ["sharp"]),
      );
      expect(npmProject.manager).toBe("npm");

      await writeFile(
        path.join(root, "package.json"),
        JSON.stringify({
          packageManager: "npm@11.0.0",
          dependencies: { sharp: "https://registry.example.com/sharp.tgz" },
        }),
      );
      const remote = await Effect.runPromise(
        Effect.result(discoverExternalPackageProject(root, ["sharp"])),
      );
      expect(Result.isFailure(remote)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("discovers npm workspaces, rejects private registries, and requires a lock", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "alchemy-external-npm-"));
    try {
      const workspace = path.join(root, "packages", "app");
      await mkdir(workspace, { recursive: true });
      await writeFile(
        path.join(root, "package.json"),
        JSON.stringify({ workspaces: ["packages/*"] }),
      );
      await writeFile(
        path.join(workspace, "package.json"),
        JSON.stringify({ dependencies: { sharp: "0.34.5" } }),
      );
      await writeFile(
        path.join(root, "package-lock.json"),
        JSON.stringify({
          lockfileVersion: 3,
          packages: {
            "node_modules/sharp": {
              resolved: "https://registry.npmjs.org/sharp/-/sharp-0.34.5.tgz",
            },
          },
        }),
      );

      const project = await Effect.runPromise(
        discoverExternalPackageProject(workspace, ["sharp"]),
      );
      expect(project.manager).toBe("npm");
      expect(project.lockRoot).toBe(root);

      await writeFile(
        path.join(root, "package-lock.json"),
        JSON.stringify({
          lockfileVersion: 3,
          packages: {
            "node_modules/sharp": {
              resolved: "https://npm.internal.example/sharp.tgz",
            },
          },
        }),
      );
      const privateRegistry = await Effect.runPromise(
        Effect.result(discoverExternalPackageProject(workspace, ["sharp"])),
      );
      expect(Result.isFailure(privateRegistry)).toBe(true);

      await unlink(path.join(root, "package-lock.json"));
      const missingLock = await Effect.runPromise(
        Effect.result(discoverExternalPackageProject(workspace, ["sharp"])),
      );
      expect(Result.isFailure(missingLock)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("collects runtime dependency closures and preserves executables", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "alchemy-external-files-"));
    try {
      const nodeModules = path.join(root, "node_modules");
      const sharp = path.join(nodeModules, "sharp");
      const runtimeDep = path.join(nodeModules, "runtime-dep");
      const runtimePeer = path.join(nodeModules, "runtime-peer");
      const installedOptional = path.join(nodeModules, "installed-optional");
      await mkdir(path.join(sharp, "bin"), { recursive: true });
      await mkdir(runtimeDep, { recursive: true });
      await mkdir(runtimePeer, { recursive: true });
      await mkdir(installedOptional, { recursive: true });
      await writeFile(
        path.join(sharp, "package.json"),
        JSON.stringify({
          dependencies: { "runtime-dep": "1.0.0" },
          optionalDependencies: {
            "installed-optional": "1.0.0",
            "missing-optional": "1.0.0",
          },
          peerDependencies: { "runtime-peer": "1.0.0" },
          devDependencies: { "dev-only": "1.0.0" },
        }),
      );
      await writeFile(path.join(runtimeDep, "package.json"), "{}");
      await writeFile(path.join(runtimeDep, "index.js"), "export default 1");
      await writeFile(path.join(runtimePeer, "package.json"), "{}");
      await writeFile(path.join(installedOptional, "package.json"), "{}");
      const executable = path.join(sharp, "bin", "sharp-tool");
      await writeFile(executable, "#!/bin/sh\n");
      await chmod(executable, 0o755);

      const files = await Effect.runPromise(
        collectExternalPackageFiles(nodeModules, ["sharp"]),
      );
      expect(files.map((file) => file.path)).toEqual([
        "node_modules/installed-optional/package.json",
        "node_modules/runtime-dep/index.js",
        "node_modules/runtime-dep/package.json",
        "node_modules/runtime-peer/package.json",
        "node_modules/sharp/bin/sharp-tool",
        "node_modules/sharp/package.json",
      ]);
      expect(files.find((file) => file.path.endsWith("sharp-tool"))?.mode).toBe(
        0o755,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("prunes a hoisted install to the selected runtime closure before export", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "alchemy-external-prune-"));
    try {
      const nodeModules = path.join(root, "node_modules");
      const output = path.join(root, "output");
      const selected = path.join(nodeModules, "selected");
      const runtime = path.join(nodeModules, "runtime");
      const devOnly = path.join(nodeModules, "dev-only");
      const unrelated = path.join(nodeModules, "unrelated");
      await Promise.all(
        [selected, runtime, devOnly, unrelated].map((directory) =>
          mkdir(directory, { recursive: true }),
        ),
      );
      await writeFile(
        path.join(selected, "package.json"),
        JSON.stringify({
          dependencies: { runtime: "1.0.0" },
          devDependencies: { "dev-only": "1.0.0" },
        }),
      );
      await writeFile(path.join(selected, "index.js"), "selected");
      await writeFile(path.join(runtime, "package.json"), "{}");
      await writeFile(path.join(runtime, "index.js"), "runtime");
      await writeFile(path.join(devOnly, "package.json"), "{}");
      await writeFile(path.join(unrelated, "package.json"), "{}");
      await writeFile(path.join(unrelated, "large.bin"), new Uint8Array(1024));

      const collector = path.join(root, "collector.mjs");
      await writeFile(collector, renderExternalPackageCollector(["selected"]));
      const result = spawnSync(process.execPath, [collector, root, output], {
        encoding: "utf8",
      });

      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(
        await readFile(
          path.join(output, "node_modules/selected/index.js"),
          "utf8",
        ),
      ).toBe("selected");
      expect(
        await readFile(
          path.join(output, "node_modules/runtime/index.js"),
          "utf8",
        ),
      ).toBe("runtime");
      await expect(
        access(path.join(output, "node_modules/dev-only")),
      ).rejects.toThrow();
      await expect(
        access(path.join(output, "node_modules/unrelated")),
      ).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects package symlinks that escape the install root", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "alchemy-external-link-"));
    const outside = await mkdtemp(
      path.join(tmpdir(), "alchemy-external-outside-"),
    );
    try {
      const sharp = path.join(root, "node_modules", "sharp");
      await mkdir(sharp, { recursive: true });
      await writeFile(path.join(sharp, "package.json"), "{}");
      const outsideFile = path.join(outside, "secret.txt");
      await writeFile(outsideFile, "outside");
      await symlink(outsideFile, path.join(sharp, "escape"));

      const result = await Effect.runPromise(
        Effect.result(
          collectExternalPackageFiles(path.join(root, "node_modules"), [
            "sharp",
          ]),
        ),
      );
      expect(Result.isFailure(result)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("renders target installs with scripts limited to selected packages", () => {
    const bunDockerfile = renderExternalPackageDockerfile({
      manager: "bun",
      runtime: "nodejs22.x",
      packages: ["ffmpeg-static", "sharp"],
      bunVersion: "1.3.14",
    });
    expect(bunDockerfile).toContain(
      "FROM --platform=$TARGETPLATFORM public.ecr.aws/sam/build-nodejs22.x:latest AS dependencies",
    );
    expect(bunDockerfile).toContain(
      "bun install --frozen-lockfile --production --ignore-scripts --linker=hoisted",
    );
    expect(bunDockerfile).toContain(
      "npm rebuild --foreground-scripts ffmpeg-static sharp",
    );
    expect(bunDockerfile).not.toContain("bun pm trust");

    const npmDockerfile = renderExternalPackageDockerfile({
      manager: "npm",
      runtime: "nodejs24.x",
      packages: ["sharp"],
      bunVersion: "unused",
    });
    expect(npmDockerfile).toContain(
      "FROM --platform=$TARGETPLATFORM public.ecr.aws/sam/build-nodejs24.x:latest AS dependencies",
    );
    expect(npmDockerfile).toContain("npm ci --omit=dev --ignore-scripts");
    expect(npmDockerfile).toContain("npm rebuild --foreground-scripts sharp");
  });

  it("creates a manifest-only Docker context without project scripts", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "alchemy-external-context-"),
    );
    try {
      const workspace = path.join(root, "packages", "app");
      const context = path.join(root, "context");
      await mkdir(workspace, { recursive: true });
      await writeFile(
        path.join(root, "package.json"),
        JSON.stringify({
          workspaces: ["packages/*"],
          packageManager: "bun@1.3.14",
          scripts: { prepare: "should-not-run" },
        }),
      );
      await writeFile(path.join(root, "bun.lock"), "{}\n");
      await writeFile(
        path.join(workspace, "package.json"),
        JSON.stringify({
          dependencies: { sharp: "0.34.5" },
          scripts: { postinstall: "should-not-run" },
        }),
      );
      const project = await Effect.runPromise(
        discoverExternalPackageProject(workspace, ["sharp"]),
      );

      const prepared = await Effect.runPromise(
        prepareExternalPackageBuildContext({
          project,
          packages: ["sharp"],
          runtime: "nodejs22.x",
          architecture: "arm64",
          bunVersion: "1.3.14",
          directory: context,
        }),
      );

      const copiedRoot = JSON.parse(
        await readFile(path.join(context, "package.json"), "utf8"),
      );
      const copiedWorkspace = JSON.parse(
        await readFile(
          path.join(context, "packages", "app", "package.json"),
          "utf8",
        ),
      );
      expect(copiedRoot.scripts).toBeUndefined();
      expect(copiedWorkspace.scripts).toBeUndefined();
      expect(await readFile(path.join(context, "bun.lock"), "utf8")).toBe(
        "{}\n",
      );
      await expect(readFile(path.join(context, ".npmrc"))).rejects.toThrow();
      expect(prepared.platform).toBe("linux/arm64");
      expect(prepared.fingerprint).toHaveLength(64);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("coalesces concurrent materializations for the same cache key", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "alchemy-external-concurrent-"),
    );
    try {
      await writeFile(
        path.join(root, "package.json"),
        JSON.stringify({ dependencies: { selected: "1.0.0" } }),
      );
      await writeFile(path.join(root, "bun.lock"), "{}\n");
      let builds = 0;
      const options = {
        packageRoot: root,
        packages: ["selected"],
        runtime: "nodejs22.x" as const,
        architecture: "arm64" as const,
        cacheDirectory: path.join(root, "cache"),
        bunVersion: "1.3.14",
        build: ({ outputDirectory }: { outputDirectory: string }) =>
          Effect.promise(async () => {
            builds += 1;
            await new Promise((resolve) => setTimeout(resolve, 50));
            const selected = path.join(
              outputDirectory,
              "node_modules/selected",
            );
            await mkdir(selected, { recursive: true });
            await writeFile(path.join(selected, "package.json"), "{}");
            await writeFile(path.join(selected, "index.js"), "selected");
          }),
      };

      const [first, second] = await Effect.runPromise(
        Effect.all(
          [
            materializeExternalPackages(options),
            materializeExternalPackages(options),
          ],
          { concurrency: "unbounded" },
        ).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
      );
      expect(builds).toBe(1);
      expect(first.hash).toBe(second.hash);

      const cached = await Effect.runPromise(
        materializeExternalPackages(options).pipe(
          Effect.provide(NodeServices.layer),
          Effect.scoped,
        ),
      );
      expect(builds).toBe(1);
      expect(cached.cacheHit).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("removes abandoned external-package build directories", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "alchemy-external-stale-"));
    try {
      const cacheDirectory = path.join(root, "cache");
      const abandoned = path.join(cacheDirectory, "build-abandoned");
      await mkdir(abandoned, { recursive: true });
      const old = new Date(Date.now() - 60 * 60 * 1000);
      await utimes(abandoned, old, old);
      await writeFile(
        path.join(root, "package.json"),
        JSON.stringify({ dependencies: { selected: "1.0.0" } }),
      );
      await writeFile(path.join(root, "bun.lock"), "{}\n");

      await Effect.runPromise(
        materializeExternalPackages({
          packageRoot: root,
          packages: ["selected"],
          runtime: "nodejs22.x",
          architecture: "arm64",
          cacheDirectory,
          bunVersion: "1.3.14",
          build: ({ outputDirectory }) =>
            Effect.promise(async () => {
              const selected = path.join(
                outputDirectory,
                "node_modules/selected",
              );
              await mkdir(selected, { recursive: true });
              await writeFile(path.join(selected, "package.json"), "{}");
            }),
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
      );

      await expect(access(abandoned)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("hashes external package contents and executable modes", () => {
    const base = [
      {
        path: "node_modules/tool/bin/tool",
        content: new Uint8Array([1, 2, 3]),
        mode: 0o755,
      },
    ];
    expect(hashExternalPackageFiles(base)).toBe(
      hashExternalPackageFiles([...base]),
    );
    expect(hashExternalPackageFiles(base)).not.toBe(
      hashExternalPackageFiles([{ ...base[0], mode: 0o644 }]),
    );
    expect(hashExternalPackageFiles(base)).not.toBe(
      hashExternalPackageFiles([
        { ...base[0], content: new Uint8Array([1, 2, 4]) },
      ]),
    );
  });

  it("includes runtime and architecture in dependency deployment hashes", () => {
    const hash = (
      runtime: "nodejs22.x" | "nodejs24.x",
      architecture: "x86_64" | "arm64",
    ) =>
      hashLambdaDeploymentCode({
        bundleHash: "bundle",
        externalHash: "external",
        runtime,
        architecture,
      });

    expect(hash("nodejs22.x", "arm64")).not.toBe(hash("nodejs22.x", "x86_64"));
    expect(hash("nodejs22.x", "arm64")).not.toBe(hash("nodejs24.x", "arm64"));
    expect(
      hashLambdaDeploymentCode({
        bundleHash: "original-bundle-hash",
        externalHash: undefined,
        runtime: "nodejs24.x",
        architecture: "arm64",
      }),
    ).toBe("original-bundle-hash");
  });

  it("enforces Lambda zip size limits before upload", async () => {
    const tooLargeUnpacked = await Effect.runPromise(
      Effect.result(
        validateLambdaPackageSize({
          uncompressedSize: 250 * 1024 * 1024 + 1,
          compressedSize: 1,
          hasAssets: true,
        }),
      ),
    );
    expect(Result.isFailure(tooLargeUnpacked)).toBe(true);

    const needsAssets = await Effect.runPromise(
      Effect.result(
        validateLambdaPackageSize({
          uncompressedSize: 100 * 1024 * 1024,
          compressedSize: 50 * 1024 * 1024 + 1,
          hasAssets: false,
        }),
      ),
    );
    expect(Result.isFailure(needsAssets)).toBe(true);

    await expect(
      Effect.runPromise(
        validateLambdaPackageSize({
          uncompressedSize: 100 * 1024 * 1024,
          compressedSize: 50 * 1024 * 1024 + 1,
          hasAssets: true,
        }),
      ),
    ).resolves.toBeUndefined();
  });
});

const verifyNativeFixture = async (manager: "bun" | "npm") => {
  const root = await mkdtemp(path.join(tmpdir(), `alchemy-${manager}-native-`));
  try {
    const taskDirectory = path.join(root, "task");
    const materialized = await Effect.runPromise(
      materializeExternalPackages({
        packageRoot: path.join(fixtureRoot, `external-packages-${manager}`),
        packages: ["sharp", "ffmpeg-static"],
        runtime: "nodejs22.x",
        architecture: "arm64",
        cacheDirectory: path.join(root, "cache"),
        bunVersion: process.versions.bun,
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    expect(
      materialized.files.some(
        (file) =>
          file.path.includes("sharp-linux-arm64") &&
          file.path.endsWith(".node"),
      ),
    ).toBe(true);
    expect(
      materialized.files.find(
        (file) => file.path === "node_modules/ffmpeg-static/ffmpeg",
      )?.mode,
    ).toBe(0o755);

    for (const file of materialized.files) {
      const target = path.join(taskDirectory, ...file.path.split("/"));
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, file.content);
      await chmod(target, file.mode);
    }
    await writeFile(
      path.join(taskDirectory, "handler.mjs"),
      await readFile(
        path.join(fixtureRoot, "external-packages-bun", "handler.mjs"),
      ),
    );

    const { stdout } = await Effect.runPromise(
      runDockerCommand([
        "run",
        "--rm",
        "--platform",
        "linux/arm64",
        "--entrypoint",
        "node",
        "-v",
        `${taskDirectory}:/var/task:ro`,
        "-w",
        "/var/task",
        "public.ecr.aws/lambda/nodejs:22",
        "--input-type=module",
        "-e",
        "import('/var/task/handler.mjs').then(async ({ verifyNativePackages }) => console.log(JSON.stringify(await verifyNativePackages())))",
      ]).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );
    const result = JSON.parse(stdout.trim().split("\n").at(-1)!) as {
      architecture: string;
      imageBytes: number;
      ffmpegStatus: number;
      ffmpegVersion: string;
    };
    expect(result.architecture).toBe("arm64");
    expect(result.imageBytes).toBeGreaterThan(0);
    expect(result.ffmpegStatus).toBe(0);
    expect(result.ffmpegVersion).toContain("ffmpeg version");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

describe("external Lambda package Docker integration", () => {
  it.skipIf(!dockerIntegrationEnabled)(
    "runs Bun-locked Sharp and FFmpeg in the ARM64 Lambda runtime",
    () => verifyNativeFixture("bun"),
    120_000,
  );

  it.skipIf(!dockerIntegrationEnabled)(
    "runs npm-locked Sharp and FFmpeg in the ARM64 Lambda runtime",
    () => verifyNativeFixture("npm"),
    120_000,
  );
});
