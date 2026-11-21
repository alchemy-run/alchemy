import { nodeTemplate, plainEnvironment, secretGrants } from "@alchemy.run/rivet/GCP/CloudRunPool";
import { startupScript } from "@alchemy.run/rivet/GCP/ComputeEnginePool";
import {
  nodeDockerfile,
  resolveRivetKitVersion,
  RIVETKIT_VERSION,
} from "@alchemy.run/rivet/internal/PoolHost";
import { describe, expect, layer, test } from "@alchemy.run/test";
import { PlatformServices } from "alchemy/Util/PlatformServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

describe("RivetGCP.CloudRunPool worker pool", { tags: ["unit"] }, () => {
  test("a pool given none of the production options runs the template it always has", () => {
    expect(nodeTemplate({})).toEqual({
      containers: [{ resources: { limits: { cpu: "1", memory: "1Gi" } } }],
    });
    expect(nodeTemplate({ cpu: "2", memory: "4Gi" }, { secretEnv: [] })).toEqual({
      containers: [{ resources: { limits: { cpu: "2", memory: "4Gi" } } }],
    });
  });

  test("a pool on a private network sends private traffic through it, and runs as its account", () => {
    const secretEnv = [
      {
        name: "RIVET_TOKEN",
        valueSource: { secretKeyRef: { secret: "projects/p/secrets/rivet", version: "2" } },
      },
    ];
    expect(
      nodeTemplate(
        { network: "private", subnetwork: "private-us" },
        { serviceAccount: "nodes@p.iam.gserviceaccount.com", secretEnv },
      ),
    ).toEqual({
      serviceAccount: "nodes@p.iam.gserviceaccount.com",
      vpcAccess: {
        egress: "PRIVATE_RANGES_ONLY",
        networkInterfaces: [{ network: "private", subnetwork: "private-us" }],
      },
      containers: [{ resources: { limits: { cpu: "1", memory: "1Gi" } }, env: secretEnv }],
    });
  });

  test("a pool with secrets and no account of the user's own keeps the worker pool's account", () => {
    const options = { secrets: { DATABASE_URL: "projects/p/secrets/db/versions/3" } };
    expect(nodeTemplate(options, { serviceAccount: undefined })).not.toHaveProperty(
      "serviceAccount",
    );
    expect(secretGrants(Object.values(options.secrets))).toEqual([
      {
        role: "roles/secretmanager.secretAccessor",
        resource: { kind: "secretmanager.secret", name: "projects/p/secrets/db" },
      },
    ]);
  });

  test("RIVET_TOKEN named in secrets leaves the plain environment, and stays in it otherwise", () => {
    const env = { RIVET_ENDPOINT: "https://rivet.acme.dev", RIVET_TOKEN: "plain" };
    expect(plainEnvironment(env, { RIVET_TOKEN: "projects/p/secrets/rivet/versions/2" })).toEqual({
      RIVET_ENDPOINT: "https://rivet.acme.dev",
    });
    expect(plainEnvironment(env, undefined)).toEqual(env);
    expect(plainEnvironment(env, { DATABASE_URL: "projects/p/secrets/db/versions/3" })).toEqual(
      env,
    );
  });
});

describe("Rivet node RivetKit release", { tags: ["unit"] }, () => {
  test("nodes install RivetKit 3.1.1 unless the pool names another release", () => {
    expect(nodeDockerfile("3.0.0")).toBe(
      "FROM oven/bun:1\nWORKDIR /app\nRUN bun add rivetkit@3.0.0\n",
    );
    expect(nodeDockerfile("3.0.7")).toContain("RUN bun add rivetkit@3.0.7\n");
    const script = (rivetkitVersion?: string) =>
      startupScript({
        bucket: "b",
        image: false,
        stopTimeout: 30,
        rolloutTimeout: 600,
        rivetkitVersion,
      });
    expect(script()).toContain("npm install --no-save --no-fund --no-audit rivetkit@3.1.1 ");
    expect(script("3.0.7")).toContain("npm install --no-save --no-fund --no-audit rivetkit@3.0.7 ");
  });
});

describe("Rivet node RivetKit release, resolved", { tags: ["unit"] }, () => {
  layer(PlatformServices)("from the program", (it) => {
    /** A program at `<dir>/src/main.ts`, with `rivetkit@<version>` installed beside it when given. */
    const program = (version?: string) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "rivetkit-version-" });
        const main = path.join(dir, "src", "main.ts");
        yield* fs.makeDirectory(path.dirname(main), { recursive: true });
        yield* fs.writeFileString(main, "export {};\n");
        if (version !== undefined) {
          const pkg = path.join(dir, "node_modules", "rivetkit");
          yield* fs.makeDirectory(pkg, { recursive: true });
          yield* fs.writeFileString(
            path.join(pkg, "package.json"),
            JSON.stringify({ name: "rivetkit", version, main: "index.js" }),
          );
          yield* fs.writeFileString(path.join(pkg, "index.js"), "module.exports = {};\n");
        }
        return main;
      });

    it.effect("nodes install the rivetkit the program resolves", () =>
      Effect.gen(function* () {
        const main = yield* program("9.8.7");
        expect(yield* resolveRivetKitVersion(main)).toBe("9.8.7");
        // The engine hands a class's module over as its `import.meta.url`.
        expect(yield* resolveRivetKitVersion(`file://${main}`)).toBe("9.8.7");
      }).pipe(Effect.scoped),
    );

    it.effect("a program that installs no rivetkit gets the one this package depends on", () =>
      Effect.gen(function* () {
        const main = yield* program();
        expect(yield* resolveRivetKitVersion(main)).toBe(RIVETKIT_VERSION);
      }).pipe(Effect.scoped),
    );
  });
});
