/**
 * Builds sandbox handles over E2B's control plane (lifecycle) and envd
 * (processes, files, terminals). envd calls address the sandbox with its
 * own access token; the host's team key is used only for control-plane
 * calls.
 */
import { sandboxConnection } from "@distilled.cloud/e2b";
import * as envd from "@distilled.cloud/e2b/envd";
import * as filesystem from "@distilled.cloud/e2b/filesystem";
import * as process from "@distilled.cloud/e2b/process";
import * as sandboxes from "@distilled.cloud/e2b/sandboxes";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Sandbox from "alchemy/Sandbox";
import type * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type { E2BAuth } from "../E2BBindings.ts";
import { E2BUnexpectedResponse, ExecTimedOut } from "../Errors.ts";
import type {
  Command,
  ConnectedSandbox,
  E2BError,
  E2BSandbox,
  ExecResult,
  ForkResult,
  Port,
  Process,
  ProcessOutput,
  ProcessSelector,
  SandboxOperations,
  StartOptions,
} from "../SandboxClient.ts";

const encoder = new TextEncoder();

const toBase64 = (data: string | Uint8Array) => {
  const bytes = typeof data === "string" ? encoder.encode(data) : data;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const seconds = (duration: Duration.Input) =>
  Math.max(1, Math.round(Duration.toMillis(Duration.fromInputUnsafe(duration)) / 1000));

const redact = (token: string | Redacted.Redacted<string> | null | undefined) =>
  token === undefined || token === null
    ? undefined
    : Redacted.isRedacted(token)
      ? token
      : Redacted.make(token);

/**
 * `allowOut` lists the only destinations a sandbox may reach: E2B allows
 * everything else unless `denyOut` blocks it, so an `allowOut` without a
 * `denyOut` denies all other traffic.
 */
export const denyUnlisted = <
  N extends { allowOut?: ReadonlyArray<string>; denyOut?: ReadonlyArray<string> },
>(
  network: N,
): N =>
  network.allowOut !== undefined && network.denyOut === undefined
    ? { ...network, denyOut: ["0.0.0.0/0"] }
    : network;

/** What envd calls need to reach one sandbox. */
interface Reach {
  readonly sandboxId: string;
  readonly accessToken: Redacted.Redacted<string> | undefined;
  readonly trafficToken: Redacted.Redacted<string> | undefined;
  readonly domain: string;
}

const reachOf = (
  info: {
    readonly sandboxID: string;
    readonly envdAccessToken?: string | Redacted.Redacted<string>;
    readonly trafficAccessToken?: string | Redacted.Redacted<string> | null;
    readonly domain?: string | null;
  },
  domain: string,
  trafficToken?: Redacted.Redacted<string>,
): Reach => ({
  sandboxId: info.sandboxID,
  accessToken: redact(info.envdAccessToken),
  trafficToken: redact(info.trafficAccessToken) ?? trafficToken,
  domain: info.domain ?? domain,
});

const processConfig = (
  command: Command,
  cwd: string | undefined,
  env: Readonly<Record<string, string>> | undefined,
) => ({
  ...(typeof command === "string"
    ? { cmd: "/bin/bash", args: ["-l", "-c", command] }
    : { cmd: command[0], args: command.slice(1) }),
  ...(env ? { envs: env } : {}),
  ...(cwd ? { cwd } : {}),
});

const signalOf = (signal: "SIGTERM" | "SIGKILL" | undefined) =>
  signal === "SIGTERM" ? ("SIGNAL_SIGTERM" as const) : ("SIGNAL_SIGKILL" as const);

/** The entry envd reports for a filesystem call; envd always sends one on success. */
const entryOf = (entry: filesystem.EntryInfo | undefined, call: string) =>
  entry === undefined
    ? Effect.fail(new E2BUnexpectedResponse({ message: `envd sent no entry for ${call}` }))
    : Effect.succeed(entry);

/**
 * The operations every handle shares. `reach` resolves how to address the
 * sandbox; `domainOf` is the domain its ports are served under; `resumed`
 * records what a resume returned; `forked` builds a handle for a fork.
 */
const makeOperations = (
  auth: E2BAuth,
  sandboxIdOf: Effect.Effect<string, never, RuntimeContext>,
  reach: Effect.Effect<Reach, E2BError, RuntimeContext>,
  domainOf: Effect.Effect<string, never, RuntimeContext>,
  resumed: (info: sandboxes.Sandbox) => void,
  forked: (info: sandboxes.Sandbox, domain: string) => E2BSandbox,
): SandboxOperations => {
  const connection = (r: Reach) =>
    Layer.mergeAll(
      sandboxConnection({
        sandboxId: r.sandboxId,
        domain: r.domain,
        ...(r.accessToken === undefined ? {} : { accessToken: r.accessToken }),
      }),
      FetchHttpClient.layer,
    );
  type Envd = Layer.Success<ReturnType<typeof connection>>;
  /** An envd call against this sandbox. */
  const inSandbox = <A, E>(effect: Effect.Effect<A, E, Envd>) =>
    Effect.flatMap(reach, (r) => effect.pipe(Effect.provide(connection(r))));
  const streamInSandbox = <A, E>(stream: Stream.Stream<A, E, Envd>) =>
    Stream.unwrap(Effect.map(reach, (r) => stream.pipe(Stream.provide(connection(r)))));
  /** A control-plane call on this sandbox. */
  const onSandbox = <A, E>(
    call: (sandboxID: string) => Effect.Effect<A, E, sandboxes.E2BOpContext>,
  ) => Effect.flatMap(sandboxIdOf, (id) => auth.authorize(call(id)));

  /**
   * Runs a process's event stream in the current scope and hands back its
   * controls once envd reports its pid. Closing the scope detaches.
   */
  const attachTo = (
    events: Stream.Stream<process.ProcessEvent, E2BError, RuntimeContext>,
    knownPid?: number,
  ): Effect.Effect<Process, E2BError, RuntimeContext | Scope.Scope> =>
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<ProcessOutput, E2BError | Cause.Done>();
      const started = yield* Deferred.make<number, E2BError>();
      const exited = yield* Deferred.make<ExecResult, E2BError>();
      if (knownPid !== undefined) yield* Deferred.succeed(started, knownPid);
      const stdout = new TextDecoder();
      const stderr = new TextDecoder();
      let pid = knownPid ?? 0;
      let out = "";
      let err = "";
      const fail = (error: E2BError) =>
        Effect.all([
          Deferred.fail(started, error),
          Deferred.fail(exited, error),
          Queue.fail(queue, error),
        ]);
      yield* events.pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            switch (event._tag) {
              case "Start":
                pid = event.pid;
                yield* Deferred.succeed(started, event.pid);
                return;
              case "Stdout":
              case "Pty":
                out += stdout.decode(event.data, { stream: true });
                yield* Queue.offer(queue, { fd: "stdout", data: event.data });
                return;
              case "Stderr":
                err += stderr.decode(event.data, { stream: true });
                yield* Queue.offer(queue, { fd: "stderr", data: event.data });
                return;
              case "End":
                yield* Deferred.succeed(exited, {
                  pid,
                  exitCode: event.exitCode,
                  stdout: out + stdout.decode(),
                  stderr: err + stderr.decode(),
                  error: event.error,
                });
                yield* Queue.end(queue);
                return;
            }
          }),
        ),
        // A stream that ends without an End event: envd dropped it.
        Effect.andThen(
          Effect.suspend(() =>
            Deferred.isDone(exited).pipe(
              Effect.flatMap((done) =>
                done
                  ? Effect.void
                  : fail(
                      new E2BUnexpectedResponse({
                        message: `envd closed process ${pid}'s stream before it exited`,
                      }),
                    ),
              ),
            ),
          ),
        ),
        Effect.catch(fail),
        Effect.forkScoped,
      );
      const processPid = yield* Deferred.await(started);
      const selector: ProcessSelector = { pid: processPid };
      return {
        id: String(processPid),
        pid: processPid,
        output: Stream.fromQueue(queue),
        write: (data) =>
          inSandbox(
            process.sendProcessInput({ process: selector, input: { stdin: toBase64(data) } }),
          ).pipe(Effect.asVoid),
        closeStdin: () =>
          inSandbox(process.closeProcessStdin({ process: selector })).pipe(Effect.asVoid),
        kill: (signal) =>
          inSandbox(
            process.sendProcessSignal({ process: selector, signal: signalOf(signal) }),
          ).pipe(Effect.asVoid),
        wait: Deferred.await(exited),
      } satisfies Process;
    });

  const start = (command: Command, options?: StartOptions) =>
    process
      .startProcess({
        process: processConfig(command, options?.cwd, options?.env),
        ...(options?.tag ? { tag: options.tag } : {}),
        ...(options?.stdin ? { stdin: true } : {}),
      })
      .pipe(streamInSandbox, (events) => attachTo(events));

  return {
    exec: (command, options) =>
      Effect.scoped(
        Effect.gen(function* () {
          const proc = yield* start(command, {
            ...(options?.cwd ? { cwd: options.cwd } : {}),
            ...(options?.env ? { env: options.env } : {}),
            ...(options?.stdin === undefined ? {} : { stdin: true }),
          });
          if (options?.stdin !== undefined) {
            yield* proc.write(options.stdin);
            yield* proc.closeStdin();
          }
          if (options?.timeout === undefined) return yield* proc.wait;
          const timeoutMs = Duration.toMillis(Duration.fromInputUnsafe(options.timeout));
          return yield* proc.wait.pipe(
            Effect.timeoutOrElse({
              duration: options.timeout,
              orElse: () =>
                proc
                  .kill()
                  .pipe(
                    Effect.ignore,
                    Effect.andThen(Effect.fail(new ExecTimedOut({ pid: proc.pid, timeoutMs }))),
                  ),
            }),
          );
        }),
      ),
    start,
    processes: {
      list: () =>
        inSandbox(process.listProcesses({})).pipe(Effect.map((res) => res.processes ?? [])),
      attach: (selector) =>
        attachTo(
          streamInSandbox(process.connectProcess({ process: selector })),
          "pid" in selector ? selector.pid : undefined,
        ),
    },
    pty: {
      open: (options) =>
        Effect.gen(function* () {
          const proc = yield* process
            .startProcess({
              process: {
                cmd: "/bin/bash",
                args: options.command ? ["-l", "-c", options.command] : ["-i", "-l"],
                envs: { TERM: "xterm-256color", ...options.env },
                ...(options.cwd ? { cwd: options.cwd } : {}),
              },
              pty: { size: { cols: options.cols, rows: options.rows } },
              ...(options.tag ? { tag: options.tag } : {}),
            })
            .pipe(streamInSandbox, (events) => attachTo(events));
          const selector: ProcessSelector = { pid: proc.pid };
          return {
            id: proc.id,
            pid: proc.pid,
            output: proc.output.pipe(Stream.map((chunk) => chunk.data)),
            write: (data: string | Uint8Array) =>
              inSandbox(
                process.sendProcessInput({ process: selector, input: { pty: toBase64(data) } }),
              ).pipe(Effect.asVoid),
            resize: (size: { readonly cols: number; readonly rows: number }) =>
              inSandbox(process.updateProcess({ process: selector, pty: { size } })).pipe(
                Effect.asVoid,
              ),
            kill: () => proc.kill(),
            wait: Effect.map(proc.wait, (result) => ({ exitCode: result.exitCode })),
          };
        }),
    },
    files: {
      read: (path) => inSandbox(envd.readFile({ path })),
      readText: (path) =>
        inSandbox(envd.readFile({ path })).pipe(
          Effect.map((bytes) => new TextDecoder().decode(bytes)),
        ),
      write: (path, data) =>
        inSandbox(
          envd.writeFiles({
            path,
            file: new Blob([typeof data === "string" ? data : new Uint8Array(data)]),
          }),
        ).pipe(Effect.asVoid),
      list: (path, options) =>
        inSandbox(filesystem.listDir({ path, depth: options?.depth ?? 1 })).pipe(
          Effect.map((res) => res.entries ?? []),
        ),
      stat: (path) =>
        inSandbox(filesystem.statPath({ path })).pipe(
          Effect.flatMap((res) => entryOf(res.entry, `stat ${path}`)),
        ),
      exists: (path) =>
        inSandbox(filesystem.statPath({ path })).pipe(
          Effect.as(true),
          Effect.catchTag("NotFound", () => Effect.succeed(false)),
        ),
      makeDir: (path) => inSandbox(filesystem.makeDir({ path })).pipe(Effect.asVoid),
      move: (source, destination) =>
        inSandbox(filesystem.movePath({ source, destination })).pipe(
          Effect.flatMap((res) => entryOf(res.entry, `move to ${destination}`)),
        ),
      remove: (path) => inSandbox(filesystem.removePath({ path })).pipe(Effect.asVoid),
      compose: (sources, destination) =>
        inSandbox(envd.composeFiles({ source_paths: [...sources], destination })).pipe(
          Effect.asVoid,
        ),
      watch: (path, options) =>
        streamInSandbox(
          filesystem.watchDir({
            path,
            recursive: options?.recursive ?? false,
            includeEntry: options?.includeEntry ?? false,
          }),
        ),
    },
    getTcpPort: (port) =>
      Effect.gen(function* () {
        const sandboxId = yield* sandboxIdOf;
        const domain = yield* domainOf;
        const host = `${port}-${sandboxId}.${domain}`;
        const url = `https://${host}`;
        // Raw HTTP to the user's own server inside the sandbox, at the URL
        // E2B serves its ports under. A proxied server request carries the
        // caller's origin and `host`; only its path and query are kept, since
        // E2B routes on the host.
        const send = (request: HttpClientRequest.HttpClientRequest) =>
          Effect.gen(function* () {
            const r = yield* reach;
            const client = yield* HttpClient.HttpClient;
            const target = yield* Effect.sync(() => new URL(request.url, url));
            return yield* client.execute(
              request.pipe(
                HttpClientRequest.setUrl(`${url}${target.pathname}${target.search}`),
                HttpClientRequest.removeHeader("host"),
                r.trafficToken === undefined
                  ? (req) => req
                  : HttpClientRequest.setHeader(
                      "e2b-traffic-access-token",
                      Redacted.value(r.trafficToken),
                    ),
              ),
            );
          }).pipe(Effect.provide(FetchHttpClient.layer));
        return { host, url, fetch: Sandbox.portFetch(send) } satisfies Port;
      }),
    describe: () => onSandbox((sandboxID) => sandboxes.getSandbox({ sandboxID })),
    pause: () =>
      onSandbox((sandboxID) => sandboxes.pauseSandbox({ sandboxID })).pipe(Effect.asVoid),
    resume: (options) =>
      onSandbox((sandboxID) =>
        sandboxes.connectSandbox({
          sandboxID,
          ...(options?.timeout === undefined ? {} : { timeout: seconds(options.timeout) }),
        }),
      ).pipe(
        Effect.tap((info) => Effect.sync(() => resumed(info))),
        Effect.asVoid,
      ),
    kill: () =>
      onSandbox((sandboxID) => sandboxes.deleteSandbox({ sandboxID })).pipe(
        Effect.asVoid,
        Effect.catchTag("NotFound", () => Effect.void),
      ),
    setTimeout: (timeout) =>
      onSandbox((sandboxID) =>
        sandboxes.setSandboxTimeout({ sandboxID, timeout: seconds(timeout) }),
      ).pipe(Effect.asVoid),
    refresh: (duration) =>
      onSandbox((sandboxID) =>
        sandboxes.refreshSandbox({
          sandboxID,
          ...(duration === undefined ? {} : { duration: seconds(duration) }),
        }),
      ).pipe(Effect.asVoid),
    updateNetwork: (network) =>
      onSandbox((sandboxID) =>
        sandboxes.updateSandboxNetwork({ ...denyUnlisted(network), sandboxID }),
      ).pipe(Effect.asVoid),
    snapshot: (options) =>
      onSandbox((sandboxID) => sandboxes.createSandboxSnapshot({ sandboxID, ...options })),
    fork: (options) =>
      onSandbox((sandboxID) =>
        sandboxes.forkSandbox({
          sandboxID,
          ...(options?.count === undefined ? {} : { count: options.count }),
          ...(options?.timeout === undefined ? {} : { timeout: seconds(options.timeout) }),
        }),
      ).pipe(
        Effect.flatMap((results) => Effect.map(auth.domain, (domain) => ({ results, domain }))),
        Effect.map(({ results, domain }) =>
          results.map((result): ForkResult =>
            result.sandbox !== undefined
              ? { _tag: "Forked", sandbox: forked(result.sandbox, domain) }
              : {
                  _tag: "ForkFailed",
                  code: result.error?.code,
                  message: result.error?.message ?? "fork failed",
                },
          ),
        ),
      ),
    metrics: () => onSandbox((sandboxID) => sandboxes.listSandboxMetrics({ sandboxID })),
    logs: (options) =>
      onSandbox((sandboxID) => sandboxes.listSandboxLogs({ ...options, sandboxID })),
  };
};

/** A handle to a sandbox created or connected at runtime, from what E2B returned. */
export const makeSandboxHandle = (
  auth: E2BAuth,
  info: sandboxes.Sandbox,
  domain: string,
): E2BSandbox => {
  let current = reachOf(info, domain);
  const operations = makeOperations(
    auth,
    Effect.succeed(info.sandboxID),
    Effect.sync(() => current),
    Effect.sync(() => current.domain),
    (resumed) => {
      current = reachOf(resumed, current.domain, current.trafficToken);
    },
    (fork, domain) => makeSandboxHandle(auth, fork, domain),
  );
  return {
    ...operations,
    sandboxId: info.sandboxID,
    templateId: info.templateID,
    domain: current.domain,
    info,
  };
};

/**
 * A handle to a sandbox declared in the stack. Its envd token is read from
 * E2B on first use (without resuming it) and kept; `trafficTokenOf` comes
 * from the sandbox's attributes, since E2B returns the traffic token only
 * on create and connect.
 */
export const makeConnectedSandbox = (
  auth: E2BAuth,
  sandboxIdOf: Effect.Effect<string, never, RuntimeContext>,
  trafficTokenOf: Effect.Effect<Redacted.Redacted<string> | undefined, never, RuntimeContext>,
): ConnectedSandbox => {
  let cached: Reach | undefined;
  const reach = Effect.suspend(() =>
    cached !== undefined
      ? Effect.succeed(cached)
      : Effect.gen(function* () {
          const sandboxID = yield* sandboxIdOf;
          const detail = yield* auth.authorize(sandboxes.getSandbox({ sandboxID }));
          const domain = yield* auth.domain;
          const trafficToken = yield* trafficTokenOf;
          const resolved = reachOf(detail, domain, trafficToken);
          cached = resolved;
          return resolved;
        }),
  );
  const domainOf = Effect.suspend(() =>
    cached !== undefined ? Effect.succeed(cached.domain) : auth.domain,
  );
  const operations = makeOperations(
    auth,
    sandboxIdOf,
    reach,
    domainOf,
    // The next call re-reads the sandbox's envd token.
    () => {
      cached = undefined;
    },
    (fork, domain) => makeSandboxHandle(auth, fork, domain),
  );
  return {
    ...operations,
    sandboxId: sandboxIdOf,
  };
};
