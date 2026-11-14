/**
 * Builds sandbox handles over Boat's REST API: commands, files, ports and
 * lifecycle all go through `/api/v1` with the binding's key.
 */
import * as boat from "@distilled.cloud/boat-dev/boat";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Sandbox from "alchemy/Sandbox";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import type { BoatAuth } from "../BoatBindings.ts";
import { BoatUnexpectedResponse, ExecTimedOut } from "../Errors.ts";
import type {
  BoatSandbox,
  Command,
  ConnectedSandbox,
  EntryInfo,
  ExecOptions,
  ExecResult,
  Port,
  Process,
  ProcessOutput,
  SandboxOperations,
  StartOptions,
} from "../SandboxClient.ts";
import { awaitSaved, whileSaving } from "./SavedSnapshot.ts";

const encoder = new TextEncoder();

const toBase64 = (data: string | Uint8Array) => {
  const bytes = typeof data === "string" ? encoder.encode(data) : data;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const fromBase64 = (data: string) => Uint8Array.from(atob(data), (char) => char.charCodeAt(0));

/** POSIX single quotes: the value verbatim. */
const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;

/** Boat's `ttlSeconds` for an auto-stop: `null` never stops. */
export const ttlOf = (autoStop: Duration.Input | false) =>
  autoStop === false
    ? null
    : Math.max(1, Math.round(Duration.toMillis(Duration.fromInputUnsafe(autoStop)) / 1000));

/** Boat runs commands for at most 10 minutes. */
const MAX_TIMEOUT_SECONDS = 600;

const timeoutSeconds = (timeout: Duration.Input) =>
  Math.min(
    MAX_TIMEOUT_SECONDS,
    Math.max(1, Math.ceil(Duration.toMillis(Duration.fromInputUnsafe(timeout)) / 1000)),
  );

/**
 * One shell line for Boat's `commands` endpoint, which takes only a line
 * and a working directory: `env` becomes exports, an argument vector is
 * quoted, and `stdin` is piped in from base64.
 */
const scriptOf = (
  command: Command,
  options?: {
    readonly env?: Readonly<Record<string, string>>;
    readonly stdin?: string | Uint8Array;
  },
) => {
  const line = typeof command === "string" ? command : command.map(quote).join(" ");
  const exports = Object.entries(options?.env ?? {})
    .map(([key, value]) => `export ${key}=${quote(value)}; `)
    .join("");
  const body = exports === "" ? line : `${exports}${line}`;
  return options?.stdin === undefined
    ? body
    : `printf %s ${quote(toBase64(options.stdin))} | base64 -d | { ${body}\n}`;
};

const entryOf = (entry: {
  readonly path: string;
  readonly isDir: boolean;
  readonly isSymlink: boolean;
  readonly size: number;
  readonly mode: string;
  readonly modifiedAt: string;
}): EntryInfo => ({
  path: entry.path,
  type: entry.isSymlink ? "symlink" : entry.isDir ? "directory" : "file",
  size: entry.size,
  mode: entry.mode,
  modifiedAt: entry.modifiedAt,
});

/**
 * The operations every handle shares. `sandboxIdOf` resolves the id (read
 * at runtime for a declared sandbox).
 */
const makeOperations = (
  auth: BoatAuth,
  sandboxIdOf: Effect.Effect<string, never, RuntimeContext>,
): SandboxOperations => {
  const onSandbox = <A, E>(
    call: (sandboxId: string) => Effect.Effect<A, E, boat.BoatOpContext>,
  ): Effect.Effect<A, E, RuntimeContext> =>
    Effect.flatMap(sandboxIdOf, (sandboxId) => auth.authorize(call(sandboxId)));

  const status = (processId: number, offsets: { stdout: number; stderr: number }) =>
    onSandbox((sandboxId) =>
      boat.getCommandStatus({
        sandboxId,
        processId,
        stdoutOffset: offsets.stdout,
        stderrOffset: offsets.stderr,
      }),
    );

  const makeProcess = (processId: number, from: { stdout: number; stderr: number }): Process => {
    /** Polls the process's logs from `from`, emitting what's new, until it exits. */
    const output = Stream.paginate(
      { offsets: from, idle: false },
      Effect.fnUntraced(function* (state) {
        if (state.idle) yield* Effect.sleep("500 millis");
        const current = yield* status(processId, state.offsets);
        const chunks: ProcessOutput[] = [];
        if (current.stdout.length > 0) {
          chunks.push({ fd: "stdout", data: encoder.encode(current.stdout) });
        }
        if (current.stderr.length > 0) {
          chunks.push({ fd: "stderr", data: encoder.encode(current.stderr) });
        }
        const offsets = {
          stdout: current.stdoutNextOffset ?? state.offsets.stdout,
          stderr: current.stderrNextOffset ?? state.offsets.stderr,
        };
        const finished = !current.running && current.more !== true;
        return [
          chunks,
          finished
            ? Option.none()
            : Option.some({ offsets, idle: chunks.length === 0 && current.more !== true }),
        ] as const;
      }),
    );
    const wait = status(processId, { stdout: 0, stderr: 0 }).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("1 second"),
        until: (current) => !current.running,
      }),
      Effect.map((current): ExecResult => ({
        exitCode: current.exitCode ?? -1,
        stdout: current.stdout,
        stderr: current.stderr,
        commandId: undefined,
      })),
    );
    return {
      id: String(processId),
      processId,
      output,
      kill: () =>
        onSandbox((sandboxId) => boat.stopCommand({ sandboxId, processId })).pipe(Effect.asVoid),
      wait,
    };
  };

  const files: SandboxOperations["files"] = {
    read: (path) =>
      onSandbox((sandboxId) => boat.readSandboxFile({ sandboxId, path, encoding: "base64" })).pipe(
        Effect.map((file) => fromBase64(file.content)),
      ),
    readText: (path) =>
      onSandbox((sandboxId) => boat.readSandboxFile({ sandboxId, path, encoding: "utf8" })).pipe(
        Effect.map((file) => file.content),
      ),
    write: (path, data) =>
      onSandbox((sandboxId) =>
        typeof data === "string"
          ? boat.writeSandboxFile({ sandboxId, path, content: data, encoding: "utf8" })
          : boat.writeSandboxFile({ sandboxId, path, content: toBase64(data), encoding: "base64" }),
      ).pipe(Effect.asVoid),
    list: (path) =>
      onSandbox((sandboxId) => boat.listFiles({ sandboxId, path })).pipe(
        Effect.map((listed) => listed.files.map(entryOf)),
      ),
    stat: (path) =>
      onSandbox((sandboxId) => boat.getFileInfo({ sandboxId, path })).pipe(Effect.map(entryOf)),
    remove: (path) =>
      onSandbox((sandboxId) => boat.deleteFile({ sandboxId, path, recursive: true })).pipe(
        Effect.asVoid,
      ),
    makeDir: (path) =>
      onSandbox((sandboxId) => boat.createFolder({ sandboxId, path })).pipe(Effect.asVoid),
    exists: (path) =>
      onSandbox((sandboxId) => boat.getFileInfo({ sandboxId, path })).pipe(
        Effect.as(true),
        Effect.catchTag("FileNotFound", () => Effect.succeed(false)),
      ),
    move: (source, destination, options) =>
      onSandbox((sandboxId) =>
        boat.moveFile({
          sandboxId,
          source,
          destination,
          ...(options?.overwrite === undefined ? {} : { overwrite: options.overwrite }),
        }),
      ).pipe(Effect.asVoid),
  };

  return {
    exec: (command: Command, options?: ExecOptions) =>
      onSandbox((sandboxId) =>
        boat.executeSandboxCommand({
          sandboxId,
          command: scriptOf(command, options),
          ...(options?.cwd === undefined ? {} : { cwd: options.cwd }),
          ...(options?.timeout === undefined
            ? {}
            : { timeoutSeconds: timeoutSeconds(options.timeout) }),
        }),
      ).pipe(
        Effect.flatMap(
          (response): Effect.Effect<ExecResult, BoatUnexpectedResponse | ExecTimedOut> => {
            if (!("exitCode" in response)) {
              return Effect.fail(
                new BoatUnexpectedResponse({
                  message: "Boat started the command in the background",
                }),
              );
            }
            if (response.timedOut === true) {
              return Effect.fail(
                new ExecTimedOut({
                  message: "The command ran past its timeout and Boat stopped it",
                  stdout: response.stdout,
                  stderr: response.stderr,
                }),
              );
            }
            return Effect.succeed<ExecResult>({
              exitCode: response.exitCode ?? -1,
              stdout: response.stdout,
              stderr: response.stderr,
              commandId: response.commandId,
            });
          },
        ),
      ),
    start: (command: Command, options?: StartOptions) =>
      onSandbox((sandboxId) =>
        boat.executeSandboxCommand({
          sandboxId,
          command: scriptOf(command, options),
          detached: true,
          ...(options?.cwd === undefined ? {} : { cwd: options.cwd }),
        }),
      ).pipe(
        Effect.flatMap((response) =>
          "processId" in response && typeof response.processId === "number"
            ? Effect.succeed(makeProcess(response.processId, { stdout: 0, stderr: 0 }))
            : Effect.fail(
                new BoatUnexpectedResponse({ message: "Boat returned no process for the command" }),
              ),
        ),
      ),
    processes: {
      attach: (processId) =>
        status(processId, { stdout: 0, stderr: 0 }).pipe(
          Effect.map((current) =>
            makeProcess(processId, {
              stdout: current.stdoutNextOffset ?? 0,
              stderr: current.stderrNextOffset ?? 0,
            }),
          ),
        ),
    },
    files,
    getTcpPort: (port, options) =>
      onSandbox((sandboxId) =>
        boat.hostPort({
          sandboxId,
          port,
          ...(options?.public === undefined ? {} : { public: options.public }),
          ...(options?.localhost === undefined ? {} : { localhost: options.localhost }),
        }),
      ).pipe(
        Effect.flatMap((hosted) =>
          hosted.url === undefined
            ? Effect.fail(
                new BoatUnexpectedResponse({ message: `Boat hosted port ${port} without a URL` }),
              )
            : Effect.sync(() => {
                const parsed = new URL(hosted.url!);
                const raw = parsed.searchParams.get("_token");
                const token = raw === null ? undefined : Redacted.make(raw);
                const base = parsed.origin;
                // A protected port reads its token from the `_port_auth`
                // cookie. The `_token` query answers with a redirect that
                // sets it, which would turn a POST into a GET, so the cookie
                // is sent directly. Boat routes on the host, so only the
                // request's path and query are kept.
                const send = (request: HttpClientRequest.HttpClientRequest) =>
                  Effect.gen(function* () {
                    const client = yield* HttpClient.HttpClient;
                    const target = new URL(request.url, base);
                    const cookie = request.headers.cookie;
                    return yield* client.execute(
                      request.pipe(
                        HttpClientRequest.setUrl(`${base}${target.pathname}${target.search}`),
                        HttpClientRequest.removeHeader("host"),
                        token === undefined
                          ? (req) => req
                          : HttpClientRequest.setHeader(
                              "cookie",
                              [cookie, `_port_auth=${Redacted.value(token)}`]
                                .filter((part) => part !== undefined && part !== "")
                                .join("; "),
                            ),
                      ),
                    );
                  }).pipe(Effect.provide(FetchHttpClient.layer));
                return { url: base, token, fetch: Sandbox.portFetch(send) } satisfies Port;
              }),
        ),
      ),
    describe: () =>
      onSandbox((sandboxId) => boat.getSandbox({ sandboxId })).pipe(
        Effect.flatMap((got) =>
          got.sandbox === undefined
            ? Effect.fail(new BoatUnexpectedResponse({ message: "Boat returned no sandbox" }))
            : Effect.succeed(got.sandbox),
        ),
      ),
    stop: () =>
      onSandbox((sandboxId) => boat.stopSandbox({ sandboxId })).pipe(
        Effect.asVoid,
        Effect.catchTag("SandboxAlreadyStopped", () => Effect.void),
      ),
    resume: (options) =>
      onSandbox((sandboxId) =>
        boat.resumeSandbox({
          sandboxId,
          ...(options?.autoStop === undefined ? {} : { ttlSeconds: ttlOf(options.autoStop) }),
        }),
      ).pipe(Effect.asVoid),
    setAutoStop: (autoStop) =>
      onSandbox((sandboxId) => boat.updateSandbox({ sandboxId, ttlSeconds: ttlOf(autoStop) })).pipe(
        Effect.asVoid,
      ),
    snapshot: (name) =>
      onSandbox((sandboxId) =>
        whileSaving(boat.saveSavedSnapshot({ sandboxId, name })).pipe(
          Effect.andThen(awaitSaved(name)),
        ),
      ),
  };
};

/** A handle to a sandbox created or connected at runtime, from what Boat returned. */
export const makeSandboxHandle = (
  auth: BoatAuth,
  info: boat.Sandbox,
  ownerLabels: Effect.Effect<Readonly<Record<string, string>>, never, RuntimeContext>,
): BoatSandbox => ({
  ...makeOperations(auth, Effect.succeed(info.id)),
  sandboxId: info.id,
  info,
  // Boat never copies labels onto a fork, so it gets the owner's again.
  fork: (forkOptions = {}) => {
    const { autoStop, ...options } = forkOptions;
    return Effect.flatMap(ownerLabels, (owner) =>
      auth.authorize(
        boat.forkSandbox({
          ...options,
          ...(autoStop === undefined ? {} : { ttlSeconds: ttlOf(autoStop) }),
          sandboxId: info.id,
          labels: { ...options.labels, ...owner },
        }),
      ),
    ).pipe(
      Effect.flatMap((forked) =>
        forked.sandbox === undefined || forked.sandbox === null
          ? Effect.fail(new BoatUnexpectedResponse({ message: "Boat returned no fork" }))
          : Effect.succeed(makeSandboxHandle(auth, forked.sandbox, ownerLabels)),
      ),
    );
  },
  delete: () =>
    auth.authorize(boat.deleteSandbox({ sandboxId: info.id, xAsciiConfirmDelete: info.id })).pipe(
      Effect.asVoid,
      Effect.catchTag("NotFound", () => Effect.void),
    ),
});

/** A handle to a sandbox declared in the stack. */
export const makeConnectedSandbox = (
  auth: BoatAuth,
  sandboxIdOf: Effect.Effect<string, never, RuntimeContext>,
): ConnectedSandbox => ({
  ...makeOperations(auth, sandboxIdOf),
  sandboxId: sandboxIdOf,
});
