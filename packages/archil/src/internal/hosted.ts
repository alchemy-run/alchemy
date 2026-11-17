/**
 * Bundling and deploying the program of an `Archil.Sandbox` with `main`: a
 * Node process run as an Archil sandbox service (`archil-sandbox services
 * create`), which restarts when it crashes and starts whenever the sandbox
 * boots.
 */
import * as archil from "@distilled.cloud/archil";
import * as Process from "@distilled.cloud/archil/Process";
import * as Bundle from "alchemy/Bundle/Bundle";
import {
  normalizeInstallTargets,
  resolvePackageInstallIdentity,
  type PackageInstall,
} from "alchemy/Bundle/InstalledPackages";
import { findCwdForBundle, resolveMainPath } from "alchemy/Bundle/TempRoot";
import {
  contextRootOf,
  extraFileDestination,
  hashExtraFiles,
  isContextRootDest,
  posixRelUnder,
  resolveExtraSource,
} from "alchemy/Util/extraFiles";
import { sha256, sha256Object } from "alchemy/Util/sha256";
import { zipFiles } from "alchemy/Util/zip";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import type * as rolldown from "rolldown";
import { waitForSandbox } from "./archil.ts";

/** A sandbox program failed to deploy or never started serving. */
export class ProgramDeployFailed extends Data.TaggedError("Archil.ProgramDeployFailed")<{
  readonly program: string;
  readonly message: string;
}> {}

/** Bundler options for a program, plus packages installed instead of bundled. */
export interface ProgramBuildOptions extends Bundle.BundleConfig {
  /**
   * Packages to `npm install` next to the program instead of bundling them
   * (native modules, or frameworks that load files at run time).
   */
  readonly install?: PackageInstall;
}

/** A host directory (or file) uploaded with the program. */
export interface ProgramExtraFile {
  readonly source: string;
  /** Destination relative to the program's directory; `"."` is the root. */
  readonly destination: string;
}

export interface HostedProgramProps {
  readonly main: string;
  readonly handler?: string;
  readonly isExternal?: boolean;
  readonly build?: ProgramBuildOptions;
  readonly extraFiles?: ReadonlyArray<ProgramExtraFile>;
}

type ProgramFile = { readonly path: string; readonly content: Uint8Array };

export interface BundledProgram {
  readonly files: ReadonlyArray<ProgramFile>;
  readonly hash: string;
  /** The entry `node` runs, relative to the program's directory. */
  readonly entryRel: string;
  /** Whether the program has a `package.json` to `npm install`. */
  readonly install: boolean;
}

/** Entry for the Effect form: the package bootstrap plus the user's `main`. */
const effectEntry = (handler: string) => (importPath: string) =>
  `
import { bootstrap } from "@alchemy.run/archil/Bootstrap";
import { ${handler} as entrypoint } from ${JSON.stringify(importPath)};

await bootstrap(entrypoint);
`;

/**
 * Entry for the async form: serve the module's `fetch(request, env)` over
 * `node:http`, with `process.env` as `env`. Nothing from alchemy or Effect
 * is bundled.
 */
const asyncEntry = (handler: string) => (importPath: string) =>
  `
import * as mod from ${JSON.stringify(importPath)};
import http from "node:http";
import { Readable } from "node:stream";

const app = mod[${JSON.stringify(handler)}] ?? mod.default;
const port = Number(process.env.PORT ?? 3000);

http
  .createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", \`http://\${req.headers.host ?? "localhost"}\`);
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        for (const v of Array.isArray(value) ? value : value === undefined ? [] : [value]) {
          headers.append(key, v);
        }
      }
      const hasBody = req.method !== "GET" && req.method !== "HEAD";
      const request = new Request(url, {
        method: req.method,
        headers,
        body: hasBody ? Readable.toWeb(req) : undefined,
        duplex: hasBody ? "half" : undefined,
      });
      const response = await app.fetch(request, process.env);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) Readable.fromWeb(response.body).pipe(res);
      else res.end();
    } catch (error) {
      console.error(error);
      if (!res.headersSent) res.writeHead(500);
      res.end("Internal Server Error");
    }
  })
  .listen(port, "0.0.0.0");
`;

/**
 * Paths left out of an upload. A tree uploaded at the program root keeps
 * its `node_modules` (framework servers like Nuxt trace their dependencies
 * there); other trees drop them.
 */
const skipped = (relative: string, atRoot: boolean) =>
  relative
    .replaceAll("\\", "/")
    .split("/")
    .some((segment) => segment === ".git" || (!atRoot && segment === "node_modules"));

/** Read every extra file into program files at their destinations. */
const collectExtraFiles = Effect.fn(function* (extraFiles: ReadonlyArray<ProgramExtraFile>) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const files: ProgramFile[] = [];
  for (const extra of extraFiles) {
    const dest = extraFileDestination(extra.destination);
    const source = resolveExtraSource(extra.source, path);
    if (!(yield* fs.exists(source))) continue;
    if ((yield* fs.stat(source)).type === "File") {
      files.push({
        path: isContextRootDest(dest) ? path.basename(source) : dest,
        content: yield* fs.readFile(source),
      });
      continue;
    }
    const atRoot = isContextRootDest(dest);
    for (const name of yield* fs.readDirectory(source, { recursive: true })) {
      if (skipped(name, atRoot)) continue;
      const full = path.join(source, name);
      if ((yield* fs.stat(full)).type !== "File") continue;
      const rel = name.replaceAll("\\", "/");
      files.push({
        path: isContextRootDest(dest) ? rel : `${dest}/${rel}`.replaceAll(/\/+/g, "/"),
        content: yield* fs.readFile(full),
      });
    }
  }
  return files;
});

/** The `package.json` that installs `build.install`, pinned to the versions the project resolves. */
const installManifest = Effect.fn(function* (cwd: string, install: PackageInstall | undefined) {
  const requested = yield* normalizeInstallTargets(install);
  if (Object.keys(requested).length === 0) return undefined;
  const identity = yield* resolvePackageInstallIdentity({ cwd, requested });
  if (Object.keys(identity.resolved).length === 0) return undefined;
  return `${JSON.stringify({ private: true, type: "module", dependencies: identity.resolved }, null, 2)}\n`;
});

/**
 * Pack `main` into the files of a Node program.
 *
 * - The Effect form bundles `main` behind the package bootstrap.
 * - The async form bundles `main` behind a `node:http` server for its
 *   `fetch(request, env)`.
 * - With `extraFiles`, `main` is already a complete Node program (a
 *   framework's server entry): it is uploaded as built, with its tree.
 */
export const bundleProgram = Effect.fn(function* (
  props: HostedProgramProps,
  virtualEntryPlugin: (content: (importPath: string) => string) => rolldown.Plugin,
) {
  const handler = props.handler ?? "default";
  const realMain = yield* resolveMainPath(props.main);
  const cwd = yield* findCwdForBundle(realMain);
  const manifest = yield* installManifest(cwd, props.build?.install);
  const manifestFiles: ProgramFile[] =
    manifest === undefined
      ? []
      : [{ path: "package.json", content: new TextEncoder().encode(manifest) }];

  if (props.isExternal && props.extraFiles !== undefined) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const extras = props.extraFiles.map((f) => ({ source: f.source, dest: f.destination }));
    const root = contextRootOf(realMain, extras, path, (source) =>
      resolveExtraSource(source, path),
    );
    const entryRel = posixRelUnder(root, realMain, path) ?? path.basename(realMain);
    const entry = yield* fs.readFile(realMain);
    const files: ProgramFile[] = [
      ...(yield* collectExtraFiles(props.extraFiles)).filter(
        (f) => !(f.path === "package.json" && manifest !== undefined),
      ),
      ...manifestFiles,
    ];
    if (!files.some((f) => f.path === entryRel)) files.push({ path: entryRel, content: entry });
    const hash = yield* sha256Object({
      entry: yield* sha256(entry),
      extra: yield* hashExtraFiles(extras),
      manifest: manifest ?? "",
      entryRel,
    });
    return { files, hash, entryRel, install: manifest !== undefined } satisfies BundledProgram;
  }

  const entry = props.isExternal ? asyncEntry(handler) : effectEntry(handler);
  const output = yield* Bundle.build(
    {
      ...props.build?.input,
      input: realMain,
      cwd,
      platform: "node",
      resolve: {
        conditionNames: [...Bundle.NODE_CONDITION_NAMES],
        ...props.build?.input?.resolve,
      },
      plugins: [props.build?.input?.plugins, virtualEntryPlugin(entry)],
    },
    {
      ...props.build?.output,
      format: "esm",
      sourcemap: props.build?.output?.sourcemap ?? false,
      minify: props.build?.output?.minify ?? false,
      entryFileNames: "index.mjs",
      strictExecutionOrder: true,
      keepNames: true,
    },
    props.build,
  );
  const files: ProgramFile[] = [
    ...output.files.map((file) => ({
      path: file.path,
      content:
        typeof file.content === "string" ? new TextEncoder().encode(file.content) : file.content,
    })),
    ...manifestFiles,
  ];
  const hash = yield* sha256Object({ bundle: output.hash, manifest: manifest ?? "" });
  return {
    files,
    hash,
    entryRel: "index.mjs",
    install: manifest !== undefined,
  } satisfies BundledProgram;
});

/** Single-quote a value for `sh`. */
const shellQuote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;

const envValue = (value: unknown): string =>
  Redacted.isRedacted(value)
    ? String(Redacted.value(value))
    : typeof value === "string"
      ? value
      : JSON.stringify(value ?? null);

/** Boot a sandbox that is paused or stopped, and wait until it runs. */
export const ensureRunning = Effect.fn(function* (sid: string) {
  const sandbox = yield* waitForSandbox(sid);
  if (sandbox.status === "paused") {
    yield* archil
      .resumeSandbox({ sid })
      .pipe(Effect.catchTag("SandboxStartConflict", () => Effect.void));
  } else if (sandbox.status === "stopped" || sandbox.status === "exited") {
    yield* archil
      .startSandbox({ sid })
      .pipe(Effect.catchTag("SandboxStartConflict", () => Effect.void));
  }
  const ready = yield* waitForSandbox(sid);
  if (ready.status !== "running") {
    return yield* new ProgramDeployFailed({
      program: sid,
      message: `Sandbox ${ready.name} is ${ready.status}, not running`,
    });
  }
});

/** Run a shell command in the sandbox and fail with its output on a non-zero exit. */
const sh = Effect.fn(function* (sid: string, program: string, command: string) {
  const result = yield* Process.exec(sid, command);
  if (result.exitCode !== 0) {
    return yield* new ProgramDeployFailed({
      program,
      message: `\`${command.split("\n")[0]}\` exited ${result.exitCode ?? result.status}: ${(result.stderr || result.stdout).trim()}`,
    });
  }
  return result.stdout;
});

/** The directory a program lives in. */
export const programDir = (name: string) => `/opt/alchemy/${name}`;

/**
 * Upload the program, (re)define its service, and wait until it answers on
 * `port` inside the sandbox.
 */
export const deployProgram = Effect.fn(function* (input: {
  readonly sid: string;
  readonly name: string;
  readonly port: number;
  readonly program: BundledProgram;
  readonly env: Record<string, unknown>;
}) {
  const dir = programDir(input.name);
  const staging = `${dir}.next`;
  yield* ensureRunning(input.sid);
  yield* sh(
    input.sid,
    input.name,
    `rm -rf ${shellQuote(staging)} && mkdir -p ${shellQuote(staging)}`,
  );
  // One archive, one upload: a framework build can have thousands of files.
  const archive = yield* zipFiles(input.program.files);
  yield* Effect.logInfo(
    `Archil.Sandbox program: uploading ${input.program.files.length} files (${Math.round(archive.byteLength / 1024)} KiB)`,
  );
  yield* Process.uploadFile(input.sid, `${staging}.zip`, archive);
  yield* sh(
    input.sid,
    input.name,
    `python3 -m zipfile -e ${shellQuote(`${staging}.zip`)} ${shellQuote(staging)} && rm -f ${shellQuote(`${staging}.zip`)}`,
  );
  if (input.program.install) {
    yield* Effect.logInfo(`Archil.Sandbox program: npm install`);
    yield* sh(
      input.sid,
      input.name,
      `cd ${shellQuote(staging)} && npm install --omit=dev --no-fund --no-audit --loglevel=error`,
    );
  }
  const envFlags = Object.entries({ ...input.env, PORT: String(input.port) })
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `--env ${shellQuote(`${key}=${envValue(value)}`)}`)
    .join(" ");
  yield* sh(
    input.sid,
    input.name,
    [
      `archil-sandbox services delete ${shellQuote(input.name)} >/dev/null 2>&1 || true`,
      `rm -rf ${shellQuote(dir)} && mv ${shellQuote(staging)} ${shellQuote(dir)}`,
      `archil-sandbox services create ${shellQuote(input.name)} --tcp-port ${input.port} --dir ${shellQuote(dir)} ${envFlags} -- node ${shellQuote(input.program.entryRel)} >/dev/null`,
    ].join(" && "),
  );
  yield* Effect.logInfo(`Archil.Sandbox program: started, waiting for port ${input.port}`);
  // Wait until the process answers HTTP on its port.
  const probe = `curl -s -o /dev/null -m 2 -w '%{http_code}' http://127.0.0.1:${input.port}/ || true`;
  const code = yield* Process.exec(input.sid, probe).pipe(
    Effect.map((r) => r.stdout.trim()),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status !== "" && status !== "000",
      times: 30,
    }),
  );
  if (code === "" || code === "000") {
    const logs = yield* Process.exec(
      input.sid,
      `archil-sandbox services logs ${shellQuote(input.name)} 2>&1 | tail -n 40`,
    ).pipe(
      Effect.map((r) => r.stdout),
      Effect.orElseSucceed(() => ""),
    );
    return yield* new ProgramDeployFailed({
      program: input.name,
      message: `The program never answered on port ${input.port}.\n${logs}`,
    });
  }
});

/** Stop the program and remove its files. Removing a missing one succeeds. */
export const removeProgram = Effect.fn(function* (sid: string, name: string) {
  const sandbox = yield* waitForSandbox(sid).pipe(
    Effect.catchTag("NotFound", () => Effect.undefined),
  );
  if (sandbox === undefined || sandbox.status === "deleted") return;
  yield* ensureRunning(sid);
  yield* Process.exec(
    sid,
    `archil-sandbox services delete ${shellQuote(name)} >/dev/null 2>&1; rm -rf ${shellQuote(programDir(name))}`,
  );
});
