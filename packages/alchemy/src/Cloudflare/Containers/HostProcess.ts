/**
 * INTERNAL — runs a container's bundled program as a process on this machine
 * under `alchemy dev` (`devHost`), instead of in Docker. One process per
 * container resource, restarted when its bundle or environment changes and
 * stopped when the resource is deleted. Lives in the dev sidecar, so it
 * survives user-code reloads.
 */
import * as Crypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

interface Running {
  readonly key: string;
  readonly url: string;
  readonly scope: Scope.Closeable;
}

const running = new Map<string, Running>();

export interface HostProcessOptions {
  /** The container resource's logical id. */
  readonly id: string;
  /** The build context holding the bundled program (`index.mjs` + chunks). */
  readonly context: string;
  readonly runtime: "bun" | "node";
  /** The program's environment (bound env, credentials, mounts). */
  readonly env: Record<string, string>;
  /** npm packages the image installs next to the program (`/app`). */
  readonly appPackages: ReadonlyArray<string>;
  /** Changes when the program or its environment changes. */
  readonly version: string;
}

/** A free TCP port on this machine. */
const freePort = Effect.promise(async () => {
  const net = await import("node:net");
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
});

/** Install the packages the image would install into `/app`, next to the bundle. */
const installAppPackages = (context: string, packages: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    if (packages.length === 0) return;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const marker = path.join(context, "node_modules", ".alchemy-app-packages");
    const want = [...packages].sort().join(" ");
    const have = yield* fs.readFileString(marker).pipe(Effect.orElseSucceed(() => ""));
    if (have === want) return;
    // A package root of its own, so npm doesn't climb into the enclosing
    // project (whose `workspace:` dependencies it can't read).
    const manifest = path.join(context, "package.json");
    if (!(yield* fs.exists(manifest))) {
      yield* fs.writeFileString(manifest, '{ "private": true, "type": "module" }\n');
    }
    const spawner = yield* ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make("npm", ["install", "--no-save", "--no-package-lock", ...packages], {
        cwd: context,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        extendEnv: true,
      }),
    );
    const [exitCode, stderr] = yield* Effect.all(
      [child.exitCode, child.stderr.pipe(Stream.decodeText, Stream.mkString)],
      { concurrency: "unbounded" },
    );
    if (exitCode !== 0) {
      return yield* Effect.die(new Error(`npm install ${want} failed: ${stderr.slice(-2000)}`));
    }
    yield* fs.writeFileString(marker, want);
  }).pipe(Effect.scoped);

/**
 * Ensure the container program runs on this machine with `options`, and
 * return its URL. Reuses the running process when nothing changed.
 */
export const ensureHostProcess = (options: HostProcessOptions) =>
  Effect.gen(function* () {
    const key = Crypto.createHash("sha256")
      .update(JSON.stringify([options.version, options.env, options.appPackages]))
      .digest("hex");
    const existing = running.get(options.id);
    if (existing?.key === key) return existing.url;
    if (existing) {
      running.delete(options.id);
      yield* Scope.close(existing.scope, Exit.void);
    }
    yield* installAppPackages(options.context, options.appPackages);
    const port = yield* freePort;
    const url = `http://127.0.0.1:${port}`;
    const scope = yield* Scope.make();
    const spawner = yield* ChildProcessSpawner;
    yield* spawner
      .spawn(
        ChildProcess.make(options.runtime, ["index.mjs"], {
          cwd: options.context,
          stdin: "ignore",
          stdout: "inherit",
          stderr: "inherit",
          extendEnv: true,
          env: { ...options.env, PORT: String(port), ALCHEMY_DEV: "true" },
        }),
      )
      .pipe(Scope.provide(scope));
    // Ready once the program answers HTTP (any status).
    const client = yield* HttpClient.HttpClient;
    yield* client.get(url).pipe(
      Effect.retry({ schedule: Schedule.spaced("300 millis"), times: 200 }),
      Effect.tapError(() => Scope.close(scope, Exit.void)),
    );
    running.set(options.id, { key, url, scope });
    return url;
  });

/** Stop the program's process, if one runs. */
export const stopHostProcess = (id: string) =>
  Effect.suspend(() => {
    const existing = running.get(id);
    if (!existing) return Effect.void;
    running.delete(id);
    return Scope.close(existing.scope, Exit.void);
  });
