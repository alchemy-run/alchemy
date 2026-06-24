import {
  installExternalPackages,
  isForceExternalModule,
  npmInstallArgs,
  parsePackageRoot,
  parsePackageRootFromSpecifier,
  validateInstallTargets,
} from "@/Bundle/ExternalPackages";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { spawnSync } from "node:child_process";
import { zipCode } from "@/Util/zip";

const integrationEnabled =
  process.env.ALCHEMY_TEST_LAMBDA_EXTERNAL_PACKAGES === "1" &&
  spawnSync("npm", ["--version"], { stdio: "ignore" }).status === 0;

describe("Lambda external packages", () => {
  it("accepts only package roots, not subpaths", () => {
    expect(parsePackageRoot("sharp")).toBe("sharp");
    expect(parsePackageRoot("@img/tool")).toBe("@img/tool");
    expect(parsePackageRoot("sharp/lib/index.js")).toBeUndefined();
    expect(parsePackageRoot("@img/sharp-linux-arm64/lib")).toBeUndefined();
    expect(parsePackageRoot("node:fs")).toBeUndefined();
    expect(parsePackageRoot("./local.js")).toBeUndefined();
  });

  it("extracts package roots from externalized module ids", () => {
    expect(parsePackageRootFromSpecifier("heic-convert")).toBe("heic-convert");
    expect(parsePackageRootFromSpecifier("heic-convert/lib")).toBe(
      "heic-convert",
    );
    expect(parsePackageRootFromSpecifier("@scope/pkg/subpath")).toBe(
      "@scope/pkg",
    );
    expect(parsePackageRootFromSpecifier("node:fs")).toBeUndefined();
    expect(parsePackageRootFromSpecifier("./local.js")).toBeUndefined();
  });

  it.effect("rejects subpaths in build.install", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(validateInstallTargets(["sharp/lib"]));
      expect(error.message).toMatch(/Invalid package name/);
    }),
  );

  it.effect("validates and normalizes install targets", () =>
    Effect.gen(function* () {
      expect(yield* validateInstallTargets(["sharp", "pg-native"])).toEqual({
        sharp: "*",
        "pg-native": "*",
      });
      expect(yield* validateInstallTargets({ sharp: "^0.33.5" })).toEqual({
        sharp: "^0.33.5",
      });
    }),
  );

  it("always force-externalizes sharp and pg-native", () => {
    expect(isForceExternalModule("sharp")).toBe(true);
    expect(isForceExternalModule("sharp/lib/index.js")).toBe(true);
    expect(isForceExternalModule("pg-native")).toBe(true);
    expect(isForceExternalModule("sharpish")).toBe(false);
  });

  it("targets Linux and the Lambda architecture", () => {
    expect(npmInstallArgs("arm64", ["sharp"])).toEqual([
      "install",
      "--force",
      "--platform=linux",
      "--os=linux",
      "--arch=arm64",
      "--cpu=arm64",
      "--libc=glibc",
    ]);
    expect(npmInstallArgs("x86_64", ["other"])).toContain("--arch=x64");
  });

  it.effect("resolves catalog versions from pnpm-workspace.yaml", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({
        prefix: "alchemy-external-catalog-",
      });

      try {
        yield* fs.writeFileString(
          path.join(root, "pnpm-workspace.yaml"),
          ["packages:", "  - packages/*", "catalog:", "  sharp: ^0.33.5"].join(
            "\n",
          ),
        );
        yield* fs.writeFileString(
          path.join(root, "package.json"),
          JSON.stringify({ dependencies: { sharp: "catalog:" } }),
        );

        const files = yield* installExternalPackages({
          cwd: root,
          install: ["sharp"],
          architecture: "arm64",
          runNpmInstall: (directory) =>
            Effect.gen(function* () {
              const packageJson = JSON.parse(
                yield* fs.readFileString(path.join(directory, "package.json")),
              );
              expect(packageJson.dependencies.sharp).toBe("^0.33.5");
            }),
        });

        expect(files.map((file) => file.path)).toContain("package.json");
      } finally {
        yield* fs.remove(root, { recursive: true }).pipe(Effect.ignore);
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("installs into an isolated artifact and returns its files", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({
        prefix: "alchemy-external-source-",
      });
      let installDirectory: string | undefined;
      let installArgs: ReadonlyArray<string> = [];
      let artifactPackageJson: unknown;

      try {
        yield* fs.writeFileString(
          path.join(root, "package.json"),
          JSON.stringify({ dependencies: { sharp: "^0.34.5" } }),
        );

        const files = yield* installExternalPackages({
          cwd: root,
          install: ["sharp"],
          architecture: "arm64",
          runNpmInstall: (directory, args) =>
            Effect.gen(function* () {
              installDirectory = directory;
              installArgs = args;
              artifactPackageJson = JSON.parse(
                yield* fs.readFileString(path.join(directory, "package.json")),
              );

              const sharpRoot = path.join(directory, "node_modules", "sharp");
              const binaryRoot = path.join(
                directory,
                "node_modules",
                "@img",
                "sharp-linux-arm64",
                "lib",
              );
              const libvipsRoot = path.join(
                directory,
                "node_modules",
                "@img",
                "sharp-libvips-linux-arm64",
                "lib",
              );
              yield* fs.makeDirectory(sharpRoot, { recursive: true });
              yield* fs.makeDirectory(binaryRoot, { recursive: true });
              yield* fs.makeDirectory(libvipsRoot, { recursive: true });
              yield* fs.writeFileString(
                path.join(sharpRoot, "package.json"),
                JSON.stringify({ name: "sharp", version: "0.34.5" }),
              );
              yield* fs.writeFile(
                path.join(binaryRoot, "sharp.node"),
                new Uint8Array([0, 1, 2, 3]),
              );
              yield* fs.writeFile(
                path.join(libvipsRoot, "libvips.so"),
                new Uint8Array([4, 5, 6, 7]),
              );
              yield* fs.writeFileString(
                path.join(directory, "package-lock.json"),
                "{}",
              );
            }),
        });

        expect(artifactPackageJson).toEqual({
          private: true,
          dependencies: { sharp: "^0.34.5" },
        });
        expect(installArgs).toEqual(npmInstallArgs("arm64", ["sharp"]));
        expect(files.map((file) => file.path)).toEqual(
          expect.arrayContaining([
            "package.json",
            "package-lock.json",
            "node_modules/sharp/package.json",
            "node_modules/@img/sharp-linux-arm64/lib/sharp.node",
            "node_modules/@img/sharp-libvips-linux-arm64/lib/libvips.so",
          ]),
        );
        const archive = yield* zipCode(
          "export const handler = () => {};",
          files,
        );
        const zip = yield* Effect.promise(async () => {
          const JSZip = (await import("jszip")).default;
          return JSZip.loadAsync(archive);
        });
        expect(
          zip.file("node_modules/@img/sharp-linux-arm64/lib/sharp.node"),
        ).not.toBeNull();
        expect(
          zip.file(
            "node_modules/@img/sharp-libvips-linux-arm64/lib/libvips.so",
          ),
        ).not.toBeNull();
        expect(installDirectory).toBeDefined();
        expect(yield* fs.exists(installDirectory!)).toBe(false);
      } finally {
        yield* fs.remove(root, { recursive: true }).pipe(Effect.ignore);
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("installs detected configured externals", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({
        prefix: "alchemy-external-detected-",
      });
      let artifactPackageJson: unknown;

      try {
        yield* fs.writeFileString(
          path.join(root, "package.json"),
          JSON.stringify({ dependencies: { "heic-convert": "^2.1.0" } }),
        );

        const files = yield* installExternalPackages({
          cwd: root,
          detected: ["heic-convert"],
          architecture: "arm64",
          runNpmInstall: (directory) =>
            Effect.gen(function* () {
              artifactPackageJson = JSON.parse(
                yield* fs.readFileString(path.join(directory, "package.json")),
              );
              const packageRoot = path.join(
                directory,
                "node_modules",
                "heic-convert",
              );
              yield* fs.makeDirectory(packageRoot, { recursive: true });
              yield* fs.writeFileString(
                path.join(packageRoot, "package.json"),
                JSON.stringify({ name: "heic-convert", version: "2.1.0" }),
              );
            }),
        });

        expect(artifactPackageJson).toEqual({
          private: true,
          dependencies: { "heic-convert": "^2.1.0" },
        });
        expect(files.map((file) => file.path)).toContain(
          "node_modules/heic-convert/package.json",
        );
      } finally {
        yield* fs.remove(root, { recursive: true }).pipe(Effect.ignore);
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe.skipIf(!integrationEnabled)(
  "Lambda external packages integration",
  () => {
    it.effect(
      "npm-installs sharp with linux arm64 native binaries",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectory({
            prefix: "alchemy-external-sharp-",
          });

          try {
            yield* fs.writeFileString(
              path.join(root, "package.json"),
              JSON.stringify({ dependencies: { sharp: "^0.33.5" } }),
            );

            const files = yield* installExternalPackages({
              cwd: root,
              install: ["sharp"],
              architecture: "arm64",
            });

            const paths = files.map((file) => file.path);
            expect(paths).toContain("node_modules/sharp/package.json");
            expect(
              paths.some((filePath) =>
                filePath.includes(
                  "node_modules/@img/sharp-linux-arm64/lib/sharp-linux-arm64.node",
                ),
              ),
            ).toBe(true);
            expect(
              paths.some((filePath) =>
                filePath.includes(
                  "node_modules/@img/sharp-libvips-linux-arm64/lib/libvips",
                ),
              ),
            ).toBe(true);
          } finally {
            yield* fs.remove(root, { recursive: true }).pipe(Effect.ignore);
          }
        }).pipe(Effect.provide(NodeServices.layer)),
      { timeout: 120_000 },
    );
  },
);
