import * as fileSystem from "@distilled.cloud/daytona/file_system";
import * as port from "@distilled.cloud/daytona/port";
import * as process from "@distilled.cloud/daytona/process";
import * as sandboxes from "@distilled.cloud/daytona/sandbox";
import * as Toolbox from "@distilled.cloud/daytona/Toolbox";
import * as Bundle from "alchemy/Bundle/Bundle";
import { findCwdForBundle, resolveMainPath } from "alchemy/Bundle/TempRoot";
import { sha256Object } from "alchemy/Util/sha256";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import type * as rolldown from "rolldown";
import { inSandbox } from "./Toolbox.ts";

/**
 * INTERNAL — the program a `Daytona.Sandbox` with `main` runs: bundled with
 * rolldown, uploaded into the sandbox, and run with Node in a session.
 */

/** The program didn't come up: it exited, or never listened on its port. */
export class ProgramStartFailed extends Data.TaggedError("Daytona.ProgramStartFailed")<{
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
  /** Session the process runs in. */
  readonly sessionId: string;
  /** The session command running the process. */
  readonly commandId: string;
  /** Content hash of the bundled program. */
  readonly codeHash: string;
  /** Hash of the process environment. */
  readonly envHash: string;
}

export const DEFAULT_PORT = 3000;
const DIR = "/home/daytona/.alchemy/program";
const SESSION = "alchemy-program";

/** The generated entry: a shim importing only the bootstrap and `main`. */
const makeBootstrap =
  (handler: string) =>
  (importPath: string): string =>
    `
import { bootstrap } from "@alchemy.run/daytona/Bootstrap";
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
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
    .join("\n") + "\n";

/** Bundle `main` for Node, with the Daytona bootstrap around an Effect program. */
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
 * or a gone session, is not running.
 */
export const isProgramRunning = (sandboxId: string, state: ProgramState) =>
  process.getSessionCommand({ sessionId: state.sessionId, commandId: state.commandId }).pipe(
    inSandbox(sandboxId),
    Effect.map((command) => command.exitCode === undefined),
    Effect.orElseSucceed(() => false),
  );

/**
 * Upload the bundle and (re)start the process, unless the same bundle and
 * environment already run. Returns the program's state and its URL.
 */
export const deployProgram = Effect.fn(function* (input: {
  readonly id: string;
  readonly sandboxId: string;
  readonly toolboxProxyUrl: string;
  readonly source: ProgramSource;
  readonly port: number;
  readonly env: Record<string, unknown>;
  readonly previous: ProgramState | undefined;
  readonly note: (message: string) => Effect.Effect<void>;
}) {
  const { id, sandboxId, port: programPort } = input;
  const inBox = inSandbox(sandboxId, input.toolboxProxyUrl);
  const envFile = renderEnv(input.env);
  const envHash = yield* envHashOf(input.env);
  const { files, hash } = yield* bundleProgram(input.source);

  const previous = input.previous;
  const running =
    previous !== undefined &&
    previous.codeHash === hash &&
    previous.envHash === envHash &&
    previous.port === programPort &&
    (yield* isProgramRunning(sandboxId, previous));

  let commandId = previous?.commandId ?? "";
  if (!running) {
    const dir = `${DIR}/${hash}`;
    yield* input.note(`Uploading ${id}'s program...`);
    yield* Toolbox.uploadFiles({
      files: [
        // Rolldown's entry chunk is `index.mjs`; other chunks keep their names.
        ...files.map((file, i) => ({
          path: `${dir}/${i === 0 ? "index.mjs" : file.path}`,
          content: file.content,
        })),
        { path: `${dir}/.env`, content: envFile },
      ],
    }).pipe(inBox);
    yield* fileSystem.setFilePermissions({ path: `${dir}/.env`, mode: "600" }).pipe(inBox);

    // Replace the running process: deleting its session ends it.
    yield* process.deleteSession({ sessionId: SESSION }).pipe(
      inBox,
      Effect.catchTag("SessionNotFound", () => Effect.void),
    );
    yield* process.createSession({ sessionId: SESSION }).pipe(inBox);
    const started = yield* process
      .sessionExecuteCommand({
        sessionId: SESSION,
        command: `cd ${dir} && set -a && . ./.env && set +a && exec node index.mjs`,
        runAsync: true,
      })
      .pipe(inBox);
    commandId = started.cmdId;

    // Ready once the port listens; fail with the logs if the process exits.
    yield* input.note(`Starting ${id}'s program on port ${programPort}...`);
    const ready = yield* Effect.gen(function* () {
      const command = yield* process
        .getSessionCommand({ sessionId: SESSION, commandId })
        .pipe(inBox);
      if (command.exitCode !== undefined) return "exited" as const;
      const { ports } = yield* port.getPorts({}).pipe(inBox);
      return (ports ?? []).includes(programPort) ? ("listening" as const) : ("starting" as const);
    }).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("1 second"),
        until: (state) => state !== "starting",
        times: 60,
      }),
    );
    if (ready !== "listening") {
      const logs = yield* process
        .getSessionCommandLogs({ sessionId: SESSION, commandId })
        .pipe(inBox);
      return yield* new ProgramStartFailed({
        message:
          ready === "exited"
            ? `${id}'s program exited before listening on port ${programPort}`
            : `${id}'s program did not listen on port ${programPort} within 60 seconds`,
        stdout: logs.stdout,
        stderr: logs.stderr,
      });
    }
    // Keep only the running bundle.
    yield* process
      .executeCommand({
        command: `find ${DIR} -mindepth 1 -maxdepth 1 ! -name ${hash} -exec rm -rf {} +`,
      })
      .pipe(inBox);
  }

  const preview = yield* sandboxes.getPortPreviewUrl({
    sandboxIdOrName: sandboxId,
    port: programPort,
  });
  return {
    url: preview.url,
    state: {
      port: programPort,
      sessionId: SESSION,
      commandId,
      codeHash: hash,
      envHash,
    } satisfies ProgramState,
  };
});
