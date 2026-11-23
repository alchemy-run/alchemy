import * as Output from "alchemy/Output";
import { RuntimeContext, sanitizeKey } from "alchemy/RuntimeContext";
import * as Sandbox from "alchemy/Sandbox";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { decodeActionError, decodeActionResponse, encodeActionRequest } from "./internal/Bare.ts";
import { encodeCbor } from "./internal/Cbor.ts";
import { engineSend, gatewaySend, gatewayUrl } from "./internal/Gateway.ts";
import type { Software } from "./Registry.ts";
import { Services, SERVICES_POOL } from "./Services.ts";

/** What every VM created from a {@link SandboxTemplate} starts with. */
export interface SandboxTemplateProps {
  /**
   * Packages installed after agentOS's default software, in order: from
   * `@alchemy.run/rivet/Registry` (`Registry.Git`), or `Registry.Url(...)`.
   * @default no extra software
   */
  readonly software?: ReadonlyArray<Software>;
  /**
   * Install agentOS's default software (coreutils, sed, grep, gawk,
   * findutils, diffutils, tar, gzip) before {@link software}.
   * @default true
   */
  readonly defaultSoftware?: boolean;
  /**
   * Environment variables every process in the VM starts with.
   * @default no extra variables
   */
  readonly environment?: Readonly<Record<string, string>>;
  /**
   * What the VM's processes may do, merged over agentOS's defaults; a scope
   * left out keeps its default. By default a VM reaches only its own
   * listeners and agentOS's allowlist of model provider endpoints.
   * @default agentOS's defaults
   */
  readonly permissions?: SandboxPermissions;
}

/** Whether a permission scope or rule allows or denies. */
export type SandboxPermissionMode = "allow" | "deny";

/** One rule of a permission scope: the operations and targets it matches. */
export interface SandboxPermissionRule {
  readonly mode: SandboxPermissionMode;
  /**
   * The operations it matches: for `network`, `dns`, `http` and `listen`.
   * @default every operation
   */
  readonly operations?: ReadonlyArray<string>;
  /**
   * The targets it matches, with `*` and `**` wildcards: for `network`,
   * `dns://<host>`, `tcp://<host>:<port>` and `unix:<path>`.
   * @default every target
   */
  readonly patterns?: ReadonlyArray<string>;
}

/**
 * A permission scope: `allow` or `deny` everything, or rules over a default.
 * A rule set replaces the scope's defaults, so a `network` rule set that
 * should keep the VM's own servers reachable allows `listen` on `tcp://**`
 * and `http` to `tcp://127.0.0.1:*` and `tcp://localhost:*`.
 */
export type SandboxPermission =
  | SandboxPermissionMode
  | {
      readonly default?: SandboxPermissionMode;
      readonly rules: ReadonlyArray<SandboxPermissionRule>;
    };

/** The permission scopes a VM is created with. */
export interface SandboxPermissions {
  /** DNS lookups, outbound connections and listeners. */
  readonly network?: SandboxPermission;
}

/** A base for agentOS VMs: the config each starts with. */
export interface SandboxTemplate {
  readonly name: string;
  readonly props: SandboxTemplateProps;
}

/**
 * A base for agentOS VMs on Rivet: the software and environment every VM
 * created from it starts with. agentOS keeps no template object, so this
 * declares nothing in the cloud; {@link CreateSandbox} creates each VM with
 * it. A VM keeps the config it was created with.
 *
 * ```typescript
 * import * as Registry from "@alchemy.run/rivet/Registry";
 *
 * const base = yield* Rivet.SandboxTemplate("Agent", {
 *   software: [Registry.Git, Registry.Ripgrep],
 *   environment: { NODE_ENV: "production" },
 * });
 * ```
 */
export const SandboxTemplate = (
  name: string,
  props: SandboxTemplateProps = {},
): Effect.Effect<SandboxTemplate> => Effect.succeed({ name, props });

/** A client was used outside a runtime: the stack itself has nothing to call from. */
export class SandboxCalledOutsideRuntime extends Data.TaggedError(
  "Rivet.SandboxCalledOutsideRuntime",
)<{
  readonly message: string;
}> {}

/** The gateway couldn't be reached, or answered with something that isn't agentOS's. */
export class SandboxRequestError extends Data.TaggedError("Rivet.SandboxRequestError")<{
  readonly action: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** agentOS refused an action: its error group and code say why. */
export class SandboxActionError extends Data.TaggedError("Rivet.SandboxActionError")<{
  readonly action: string;
  readonly group: string;
  readonly code: string;
  readonly message: string;
}> {}

export type SandboxError = SandboxCalledOutsideRuntime | SandboxRequestError | SandboxActionError;

/** An agentOS VM: exec, processes, files, a terminal, and its servers' ports. */
export interface SandboxHandle
  extends
    Sandbox.SandboxExec<SandboxError>,
    Sandbox.SandboxProcesses<SandboxError>,
    Sandbox.SandboxFiles<SandboxError>,
    Sandbox.SandboxPty<SandboxError>,
    Sandbox.SandboxPorts<SandboxError> {
  /** The key the VM is addressed by. */
  readonly key: string;
  /** Destroy the VM and its storage. The next `getOrCreate` of its key starts an empty one. */
  destroy(): Effect.Effect<void, SandboxError, RuntimeContext>;
}

/** agentOS VMs created from one {@link SandboxTemplate}. */
export interface SandboxClient {
  /**
   * The VM addressed by `key`: created from the template on its first call,
   * and the same VM, with its files and processes, on every call after.
   */
  getOrCreate(key: string): SandboxHandle;
}

/** What a caller needs to reach the gateway. */
interface Target {
  readonly endpoint: string;
  readonly token: string;
  readonly namespace: string;
}

/** The prebuilt actor Rivet Services runs one VM in. */
const ACTOR = "agentOS";

/** How long an output poll that found nothing waits before the next. */
const POLL_INTERVAL = "250 millis";

const commandParts = (command: Sandbox.Command) =>
  typeof command === "string"
    ? { command: "sh", args: ["-c", command] }
    : { command: command[0], args: command.slice(1) };

const timeoutMillis = (timeout: Duration.Input | undefined) =>
  timeout === undefined ? undefined : Duration.toMillis(Duration.fromInputUnsafe(timeout));

const decoder = new TextDecoder();

/** Base64url without padding, as the gateway reads `rvt-input`. */
const base64Url = (bytes: Uint8Array) => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
};

interface OutputPage {
  readonly events: ReadonlyArray<{
    readonly stream: "stdout" | "stderr";
    readonly data: Uint8Array;
  }>;
  readonly nextCursor?: number | bigint | null;
  readonly end?: unknown;
}

/**
 * A process's or terminal's output, read page by page from `after` until it
 * ends: a poll that finds nothing new waits briefly before the next.
 */
const outputOf = <E>(read: (after: number | bigint | undefined) => Effect.Effect<OutputPage, E>) =>
  Stream.paginate(undefined as number | bigint | undefined, (after) =>
    Effect.gen(function* () {
      const page = yield* read(after);
      const ended = page.end !== undefined && page.end !== null;
      if (page.events.length === 0 && !ended) yield* Effect.sleep(POLL_INTERVAL);
      const next = page.nextCursor ?? after;
      return [page.events, ended ? Option.none() : Option.some(next ?? undefined)] as const;
    }),
  );

const makeHandle = (target: Target | undefined, template: SandboxTemplate, key: string) => {
  // The VM's create input: the template's config, read by the gateway when
  // it creates the actor and ignored after.
  const input = base64Url(
    encodeCbor({
      config: {
        software: template.props.software,
        defaultSoftware: template.props.defaultSoftware,
        environment: template.props.environment,
        permissions: template.props.permissions,
      },
    }),
  );

  /** Call one of the VM's actions through the gateway. */
  const call = <A>(action: string, args: ReadonlyArray<unknown>) =>
    Effect.gen(function* () {
      if (target === undefined) {
        return yield* new SandboxCalledOutsideRuntime({
          message: `Rivet.CreateSandbox(${template.name}) can only be called inside a runtime.`,
        });
      }
      const url = gatewayUrl(
        { ...target, pool: SERVICES_POOL, name: ACTOR, key: [key] },
        `/${encodeURIComponent(action)}`,
        `?rvt-input=${input}`,
        "action",
      );
      const response = yield* Effect.tryPromise({
        try: (signal) =>
          gatewaySend(url, target.token, {
            method: "POST",
            headers: { "content-type": "application/octet-stream", "x-rivet-encoding": "bare" },
            body: encodeActionRequest(args),
            signal,
          }),
        catch: (cause) =>
          new SandboxRequestError({ action, message: `${action}: ${String(cause)}`, cause }),
      });
      const body = yield* Effect.tryPromise({
        try: () => response.arrayBuffer().then((buffer) => new Uint8Array(buffer)),
        catch: (cause) =>
          new SandboxRequestError({ action, message: `${action}: ${String(cause)}`, cause }),
      });
      const unreadable = (cause: unknown) =>
        new SandboxRequestError({
          action,
          message: `${action}: HTTP ${response.status}, a body that isn't RivetKit's`,
          cause,
        });
      if (!response.ok) {
        const error = yield* decodeActionError(body).pipe(Effect.mapError(unreadable));
        return yield* new SandboxActionError({ action, ...error });
      }
      return (yield* decodeActionResponse(body).pipe(Effect.mapError(unreadable))) as A;
    });

  const v1 = <A>(action: string, input: unknown) => call<A>(`v1.${action}`, [input]);

  const exec: SandboxHandle["exec"] = (command, options) =>
    Effect.map(
      v1<{ status: { exitCode: number }; stdout: string; stderr: string }>("process.run", {
        ...commandParts(command),
        options: {
          cwd: options?.cwd,
          env: options?.env,
          stdin: options?.stdin,
          timeoutMs: timeoutMillis(options?.timeout),
        },
      }),
      (result) => ({
        exitCode: result.status.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
      }),
    );

  type ProcessId = { readonly generation: number | bigint; readonly pid: number };

  const start: SandboxHandle["start"] = (command, options) =>
    Effect.gen(function* () {
      const process = yield* Effect.acquireRelease(
        v1<ProcessId>("process.spawn", {
          ...commandParts(command),
          options: { cwd: options?.cwd, env: options?.env, openStdin: true },
        }),
        // Leaving the scope ends a process that's still running.
        (process) => Effect.ignore(v1("process.signal", { process, signal: "SIGKILL" })),
      );
      if (options?.stdin !== undefined) {
        yield* v1("process.stdin.write", { process, data: options.stdin });
        yield* v1("process.stdin.close", { process });
      }
      return {
        id: `${process.generation}:${process.pid}`,
        output: outputOf((after) =>
          v1<OutputPage>("process.output.read", { process, after: after ?? null }),
        ).pipe(Stream.map((event) => ({ fd: event.stream, data: event.data }))),
        write: (data) => Effect.asVoid(v1("process.stdin.write", { process, data })),
        kill: (signal) =>
          Effect.asVoid(v1("process.signal", { process, signal: signal ?? "SIGTERM" })),
        wait: Effect.map(
          v1<{ status: { exitCode: number } }>("process.wait", { process }),
          (waited) => ({ exitCode: waited.status.exitCode }),
        ),
      } satisfies Sandbox.Process<SandboxError>;
    });

  type Stat = {
    readonly isDirectory: boolean;
    readonly isSymbolicLink: boolean;
    readonly sizeBytes: number | bigint;
  };
  const entryOf = (
    path: string,
    stat: Pick<Stat, "isDirectory" | "isSymbolicLink"> & Partial<Stat>,
  ) => ({
    path,
    type: stat.isSymbolicLink
      ? ("symlink" as const)
      : stat.isDirectory
        ? ("directory" as const)
        : ("file" as const),
    ...(stat.sizeBytes === undefined ? {} : { size: Number(stat.sizeBytes) }),
  });

  const files: SandboxHandle["files"] = {
    read: (path) => v1<Uint8Array>("filesystem.readFile", { path }),
    readText: (path) =>
      Effect.map(v1<Uint8Array>("filesystem.readFile", { path }), (bytes) => decoder.decode(bytes)),
    write: (path, data) => Effect.asVoid(v1("filesystem.writeFile", { path, content: data })),
    list: (path) =>
      Effect.map(
        v1<ReadonlyArray<{ name: string; isDirectory: boolean; isSymbolicLink: boolean }>>(
          "filesystem.readdirEntries",
          { path },
        ),
        (entries) =>
          entries.map((entry) => entryOf(`${path.replace(/\/+$/, "")}/${entry.name}`, entry)),
      ),
    stat: (path) =>
      Effect.map(v1<Stat>("filesystem.stat", { path }), (stat) => entryOf(path, stat)),
    remove: (path) => Effect.asVoid(v1("filesystem.remove", { path, recursive: true })),
    makeDir: (path) => Effect.asVoid(v1("filesystem.mkdir", { path, recursive: true })),
  };

  type TerminalId = { readonly generation: number | bigint; readonly shellId: string };

  const pty: SandboxHandle["pty"] = {
    open: (options) =>
      Effect.gen(function* () {
        const terminal = yield* Effect.acquireRelease(
          v1<TerminalId>("terminal.open", {
            options: {
              command: options.command,
              cwd: options.cwd,
              env: options.env,
              cols: options.cols,
              rows: options.rows,
            },
          }),
          (terminal) => Effect.ignore(v1("terminal.close", { terminal })),
        );
        return {
          id: terminal.shellId,
          output: outputOf((after) =>
            v1<OutputPage>("terminal.output.read", { terminal, after: after ?? null }),
          ).pipe(Stream.map((event) => event.data)),
          write: (data) => Effect.asVoid(v1("terminal.stdin.write", { terminal, data })),
          resize: ({ cols, rows }) =>
            Effect.asVoid(v1("terminal.pty.resize", { terminal, cols, rows })),
        } satisfies Sandbox.PtyConnection<SandboxError>;
      }),
  };

  const getTcpPort: SandboxHandle["getTcpPort"] = (port) =>
    Effect.succeed({
      // A request to a server in the VM, carried by agentOS's own fetch.
      fetch: Sandbox.portFetch((request) =>
        Effect.gen(function* () {
          const url = new URL(request.url, "http://vm");
          const body =
            request.body._tag === "Uint8Array"
              ? request.body.body
              : request.body._tag === "Empty"
                ? undefined
                : undefined;
          const response = yield* v1<{
            status: number;
            statusText: string;
            headers: ReadonlyArray<readonly [string, string]>;
            body: Uint8Array;
          }>("network.fetch", {
            request: {
              port,
              path: `${url.pathname}${url.search}`,
              method: request.method,
              headers: request.headers,
              body,
            },
          });
          return HttpClientResponse.fromWeb(
            request,
            new Response(response.body as BodyInit, {
              status: response.status,
              statusText: response.statusText,
              headers: response.headers as Array<[string, string]>,
            }),
          );
        }),
      ),
    });

  /**
   * agentOS has no destroy action: the control plane deletes the VM's actor,
   * found by its key. A VM that was never created has nothing to delete.
   */
  const destroy = () =>
    Effect.gen(function* () {
      if (target === undefined) {
        return yield* new SandboxCalledOutsideRuntime({
          message: `Rivet.CreateSandbox(${template.name}) can only be called inside a runtime.`,
        });
      }
      const base = target.endpoint.replace(/\/+$/, "");
      const engine = (method: "GET" | "DELETE", path: string) =>
        Effect.tryPromise({
          try: async (signal) => {
            const response = await engineSend(`${base}${path}`, target.token, { method, signal });
            const text = await response.text();
            return { ok: response.ok, status: response.status, text };
          },
          catch: (cause) =>
            new SandboxRequestError({
              action: "destroy",
              message: `destroy: ${String(cause)}`,
              cause,
            }),
        }).pipe(
          Effect.flatMap((response) =>
            response.ok
              ? Effect.succeed(response.text)
              : Effect.fail(
                  new SandboxRequestError({
                    action: "destroy",
                    message: `destroy: HTTP ${response.status} ${response.text}`.trim(),
                  }),
                ),
          ),
        );
      const query = new URLSearchParams({ namespace: target.namespace, name: ACTOR, key });
      const listed = yield* engine("GET", `/actors?${query}`);
      const actors = yield* Effect.try({
        try: () =>
          (
            JSON.parse(listed) as {
              actors: ReadonlyArray<{ actor_id: string; destroy_ts: unknown }>;
            }
          ).actors,
        catch: (cause) =>
          new SandboxRequestError({
            action: "destroy",
            message: "destroy: unreadable actor list",
            cause,
          }),
      });
      const namespace = new URLSearchParams({ namespace: target.namespace });
      for (const actor of actors) {
        if (actor.destroy_ts !== null && actor.destroy_ts !== undefined) continue;
        yield* engine("DELETE", `/actors/${encodeURIComponent(actor.actor_id)}?${namespace}`);
      }
    });

  return {
    key,
    exec,
    start,
    files,
    pty,
    getTcpPort,
    destroy,
  } satisfies SandboxHandle;
};

/**
 * agentOS VMs on Rivet, created from a {@link SandboxTemplate}: one VM per
 * key, each its own Rivet actor on the Rivet Services pool, reached through
 * the control plane's gateway. A VM runs a Linux-compatible userland on
 * WebAssembly and V8 isolates, keeps its files across sleep, and sleeps when
 * idle unless a process is running.
 *
 * Calls go over HTTP, so any runtime can make them (a Docker service, a
 * Lambda, a Worker) without RivetKit. Bound in a runtime, the client reads
 * the control plane's address and token from its environment, as
 * `Rivet.DurableStream` does; provide a services pool's Layer
 * (`RivetDocker.ServicesPool`, …).
 *
 * ### Running commands in a VM
 * **Example:** One VM per task, from a base with git
 * ```typescript
 * import * as Rivet from "@alchemy.run/rivet";
 * import * as Registry from "@alchemy.run/rivet/Registry";
 *
 * const base = yield* Rivet.SandboxTemplate("Agent", { software: [Registry.Git] });
 * const sandboxes = yield* Rivet.CreateSandbox(base);
 * // in fetch:
 * const sandbox = sandboxes.getOrCreate(taskId);
 * yield* sandbox.files.write("/home/agentos/hello.sh", "echo hello");
 * const result = yield* sandbox.exec(["sh", "/home/agentos/hello.sh"]);
 * ```
 *
 * `exec` runs to completion and returns `{ exitCode, stdout, stderr }`; a
 * non-zero exit is returned, not failed. A string runs in `sh -c`, an array
 * runs directly.
 *
 * ### Streaming a process
 * **Example:** Read a process's output as it runs, then wait for it
 * ```typescript
 * const build = yield* sandbox.start("npm run build", { cwd: "/home/agentos/app" });
 * yield* build.output.pipe(
 *   Stream.runForEach((chunk) => Effect.log(new TextDecoder().decode(chunk.data))),
 * );
 * const { exitCode } = yield* build.wait;
 * ```
 *
 * ### Reaching a server in the VM
 * **Example:** Fetch from a port the VM listens on
 * ```typescript
 * const port = yield* sandbox.getTcpPort(3000);
 * const response = yield* port.fetch(HttpClientRequest.get("/health"));
 * ```
 *
 * @binding
 */
export const CreateSandbox = (
  template: SandboxTemplate,
): Effect.Effect<SandboxClient, never, Services> =>
  Effect.gen(function* () {
    const services = yield* Services;
    const ctx = Option.getOrUndefined(yield* Effect.serviceOption(RuntimeContext));
    // Outside a runtime (the stack itself) there is nothing to call from.
    if (ctx === undefined) {
      return { getOrCreate: (key) => makeHandle(undefined, template, key) } satisfies SandboxClient;
    }
    // Bound as environment values while deploying; read back at runtime.
    const bind = <T>(key: string, value: unknown) =>
      ctx
        .set(
          sanitizeKey(`RIVET_SERVICES_${key}`),
          Output.isOutput(value) ? value : Output.literal(value),
        )
        .pipe(Effect.flatMap((bound) => ctx.get<T>(bound)));
    const token = yield* bind<Redacted.Redacted<string> | string>("TOKEN", services.token);
    const target: Target = {
      endpoint: (yield* bind<string>("ENDPOINT", services.endpoint)) ?? "",
      namespace: (yield* bind<string>("NAMESPACE", services.namespace)) ?? "",
      token: token === undefined ? "" : Redacted.isRedacted(token) ? Redacted.value(token) : token,
    };
    return { getOrCreate: (key) => makeHandle(target, template, key) } satisfies SandboxClient;
  });
