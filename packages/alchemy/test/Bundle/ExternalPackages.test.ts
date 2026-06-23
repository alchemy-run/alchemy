import {
  externalPackageNames,
  installExternalPackages,
  npmInstallArgs,
} from "@/Bundle/ExternalPackages";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { zipCode } from "@/Util/zip";

describe("Lambda external packages", () => {
  it("extracts only finite package names", () => {
    expect(
      externalPackageNames([
        "sharp",
        "@img/sharp-linux-arm64/lib",
        "node:fs",
        "./local.js",
        /^native-/,
      ]),
    ).toEqual(["@img/sharp-linux-arm64", "sharp"]);
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
          external: ["sharp", /^ignored$/],
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
});
