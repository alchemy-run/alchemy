import * as boat from "@distilled.cloud/boat-dev/boat";
import * as Bundle from "alchemy/Bundle/Bundle";
import { findCwdForBundle, resolveMainPath } from "alchemy/Bundle/TempRoot";
import { sha256Object } from "alchemy/Util/sha256";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import type * as rolldown from "rolldown";

/**
 * INTERNAL — the program a `Boat.Sandbox` with `main` runs: bundled with
 * rolldown, uploaded into the sandbox, and run with Node as a background
 * command.
 */

/** The program didn't come up: it exited, or never listened on its port. */
export class ProgramStartFailed extends Data.TaggedError("Boat.ProgramStartFailed")<{
  readonly message: string;
  readonly stdout: string;
  readonly stderr: string;
}> {}

/** What a sandbox's program is: the props that shape its bundle. */
export interface ProgramSource {
  readonly main: string;
  readonly handler?: string;
  readonly isExternal?: boolean;
  readonly build?: Bundle.BundleConfig;
}

/** The running program, as recorded in the sandbox's attributes. */
export interface ProgramState {
  /** Port the program listens on. */
  readonly port: number;
  /** Boat's process id for the background command running it. */
  readonly processId: number;
  /** Content hash of the bundled program. */
  readonly codeHash: string;
  /** Hash of the process environment. */
  readonly envHash: string;
}

export const DEFAULT_PORT = 3000;
const DIR = "/home/user/.alchemy/program";

/** Boat writes files up to 5 MiB in one call; larger ones go through a signed upload URL. */
const MAX_INLINE_BYTES = 4 * 1024 * 1024;

/** The generated entry: a shim importing only the bootstrap and `main`. */
const makeBootstrap =
  (handler: string) =>
  (importPath: string): string =>
    `
import { bootstrap } from "@alchemy.run/boat/Bootstrap";
import { ${handler} as entrypoint } from ${JSON.stringify(importPath)};

await bootstrap(entrypoint);
`;

const shellQuote = (value: unknown) => {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
  return `'${text.replaceAll("'", `'\\''`)}'`;
};

/** The process environment as a shell file, sorted so its hash is stable. */
export const renderEnv = (env: Record<string, unknown>) =>
  Object.entries(env)
    .filter(([, value]) => value !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([key, value]) =>
        `${key}=${shellQuote(Redacted.isRedacted(value) ? Redacted.value(value) : value)}`,
    )
    .join("\n") + "\n";

/** Bundle `main` for Node, with the Boat bootstrap around an Effect program. */
export const bundleProgram = Effect.fn(function* (source: ProgramSource) {
  const virtualEntryPlugin = yield* Bundle.virtualEntryPlugin;
  const realMain = yield* resolveMainPath(source.main);
  const cwd = yield* findCwdForBundle(realMain);
  const plugins: rolldown.RolldownPluginOption = source.isExternal
    ? undefined
    : virtualEntryPlugin(makeBootstrap(source.handler ?? "default"));
  const output = yield* Bundle.build(
    {
      ...source.build?.input,
      input: realMain,
      cwd,
      platform: "node",
      resolve: {
        conditionNames: [...Bundle.NODE_CONDITION_NAMES],
        ...source.build?.input?.resolve,
      },
      plugins: [source.build?.input?.plugins, plugins],
    },
    {
      ...source.build?.output,
      format: "esm",
      sourcemap: source.build?.output?.sourcemap ?? false,
      minify: source.build?.output?.minify ?? false,
      entryFileNames: "index.mjs",
    },
    source.build,
  );
  const files = output.files.map((file) => ({
    path: file.path,
    content:
      typeof file.content === "string" ? new TextEncoder().encode(file.content) : file.content,
  }));
  return { files, hash: (yield* sha256Object({ bundle: output.hash })).slice(0, 16) };
});

/** The hash of a process environment. */
export const envHashOf = (env: Record<string, unknown>) =>
  Effect.map(sha256Object({ env: renderEnv(env) }), (hash) => hash.slice(0, 16));

/**
 * Whether the program's process still runs. A stopped or deleted sandbox,
 * or a process Boat no longer knows, is not running.
 */
export const isProgramRunning = (sandboxId: string, state: ProgramState) =>
  boat.getCommandStatus({ sandboxId, processId: state.processId, tailBytes: 0 }).pipe(
    Effect.map((status) => status.running),
    Effect.orElseSucceed(() => false),
  );

const toBase64 = (bytes: Uint8Array) => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

/** Write one file into the sandbox, through a signed URL when it is too large for one call. */
const upload = Effect.fn(function* (sandboxId: string, path: string, content: Uint8Array) {
  if (content.byteLength <= MAX_INLINE_BYTES) {
    yield* boat.writeSandboxFile({
      sandboxId,
      path,
      content: toBase64(content),
      encoding: "base64",
    });
    return;
  }
  const signed = yield* boat.createUploadUrl({ sandboxId, path, ttlSeconds: 600 });
  const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);
  yield* client.execute(
    HttpClientRequest.put(signed.url).pipe(HttpClientRequest.bodyUint8Array(content)),
  );
});

/**
 * Upload the bundle and (re)start the process, unless the same bundle and
 * environment already run. Returns the program's state.
 */
export const deployProgram = Effect.fn(function* (input: {
  readonly id: string;
  readonly sandboxId: string;
  readonly source: ProgramSource;
  readonly port: number;
  readonly env: Record<string, unknown>;
  readonly previous: ProgramState | undefined;
  readonly note: (message: string) => Effect.Effect<void>;
}) {
  const { id, sandboxId, port } = input;
  const envFile = renderEnv(input.env);
  const envHash = yield* envHashOf(input.env);
  const { files, hash } = yield* bundleProgram(input.source);

  const previous = input.previous;
  const running =
    previous !== undefined &&
    previous.codeHash === hash &&
    previous.envHash === envHash &&
    previous.port === port &&
    (yield* isProgramRunning(sandboxId, previous));
  if (running) return previous;

  const dir = `${DIR}/${hash}`;
  yield* input.note(`Uploading ${id}'s program...`);
  // Rolldown's entry chunk is `index.mjs`; other chunks keep their names.
  yield* Effect.forEach(
    files,
    (file, i) => upload(sandboxId, `${dir}/${i === 0 ? "index.mjs" : file.path}`, file.content),
    { concurrency: 4, discard: true },
  );
  yield* upload(sandboxId, `${dir}/.env`, new TextEncoder().encode(envFile));

  // Replace the running process.
  if (previous !== undefined) {
    yield* boat.stopCommand({ sandboxId, processId: previous.processId }).pipe(Effect.ignore);
  }
  // Free the port from any earlier copy Boat lost track of (a crashed deploy).
  yield* boat
    .executeSandboxCommand({ sandboxId, command: `fuser -k ${port}/tcp 2>/dev/null; true` })
    .pipe(Effect.ignore);
  const started = yield* boat.executeSandboxCommand({
    sandboxId,
    command: `chmod 600 ${dir}/.env && cd ${dir} && set -a && . ./.env && set +a && exec node index.mjs`,
    detached: true,
  });
  if (!("processId" in started) || typeof started.processId !== "number") {
    return yield* new ProgramStartFailed({
      message: `Boat started ${id}'s program without a process id`,
      stdout: "",
      stderr: "",
    });
  }
  const processId = started.processId;

  // Ready once the port listens; fail with the logs if the process exits.
  yield* input.note(`Starting ${id}'s program on port ${port}...`);
  const ready = yield* Effect.gen(function* () {
    const status = yield* boat.getCommandStatus({ sandboxId, processId, tailBytes: 0 });
    if (!status.running) return "exited" as const;
    const probe = yield* boat.executeSandboxCommand({
      sandboxId,
      command: `(exec 3<>/dev/tcp/127.0.0.1/${port}) 2>/dev/null`,
      timeoutSeconds: 5,
    });
    return "exitCode" in probe && probe.exitCode === 0
      ? ("listening" as const)
      : ("starting" as const);
  }).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (state) => state !== "starting",
      times: 60,
    }),
  );
  if (ready !== "listening") {
    const logs = yield* boat.getCommandStatus({ sandboxId, processId });
    return yield* new ProgramStartFailed({
      message:
        ready === "exited"
          ? `${id}'s program exited before listening on port ${port}`
          : `${id}'s program did not listen on port ${port} within 60 seconds`,
      stdout: logs.stdout,
      stderr: logs.stderr,
    });
  }
  // Keep only the running bundle.
  yield* boat.executeSandboxCommand({
    sandboxId,
    command: `find ${DIR} -mindepth 1 -maxdepth 1 ! -name ${hash} -exec rm -rf {} +`,
  });
  return { port, processId, codeHash: hash, envHash } satisfies ProgramState;
});
