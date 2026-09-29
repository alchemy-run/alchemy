import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { makeCommandRedactor } from "../Command/Redaction.ts";
import {
  AuthenticationFailed,
  ConnectionLost,
  ExecTimeout,
  HostKeyMismatch,
  InvalidEnvName,
  SpawnError,
  SudoRefused,
  TransferError,
  type ExecError,
  type SessionError,
} from "./Errors.ts";

/**
 * - `strict` — the host must already be in `known_hosts`.
 * - `accept-new` — record an unknown host, refuse a changed key.
 * - `off` — no host-key checking at all.
 */
export type HostKeyPolicy = "strict" | "accept-new" | "off";

export interface ConnectOptions {
  host: string;
  user: string;
  /** @default 22 */
  port?: number;
  /**
   * PEM private key. When omitted, `ssh` uses the agent and the default
   * identities.
   */
  privateKey?: Redacted.Redacted<string>;
  /**
   * Offer only `privateKey` (`IdentitiesOnly=yes`).
   * @default true
   */
  identitiesOnly?: boolean;
  /** @default "accept-new" */
  hostKeyPolicy?: HostKeyPolicy;
  /**
   * Reuse one `ControlMaster` session across commands. Off by default: a
   * master keeps the groups it logged in with, so `usermod -aG` never takes
   * effect for later commands.
   * @default false
   */
  multiplex?: boolean;
  /** @default "10 seconds" */
  connectTimeout?: Duration.Input;
  /**
   * Values to keep out of errors and logs. `Redacted` env values passed to
   * `exec` are added automatically.
   */
  secrets?: ReadonlyArray<Redacted.Redacted<string>>;
}

export interface ExecOptions {
  /** Run as root via `sudo -n -H`. */
  sudo?: boolean;
  cwd?: string;
  /** Exported inside the remote script, so they survive `sudo`. */
  env?: Record<string, string | Redacted.Redacted<string>>;
  stdin?: string | Uint8Array;
  timeout?: Duration.Input;
  /** The remote shell that runs the command. @default "sh" */
  shell?: string;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ClientShape {
  readonly host: string;
  readonly user: string;
  /**
   * Run a command. A non-zero exit is returned in `code`, not failed: only a
   * lost session, a refused `sudo` or a timeout fail.
   */
  readonly exec: (
    command: string,
    options?: ExecOptions,
  ) => Effect.Effect<ExecResult, ExecError>;
  /** Copy a local file, or bytes, to `remote`, creating its parent directory. */
  readonly upload: (
    local: string | Uint8Array,
    remote: string,
  ) => Effect.Effect<void, TransferError | ExecError>;
  /** Succeeds once the remote shell answers. */
  readonly ping: Effect.Effect<void, SessionError>;
  /** Strip the session's secrets from a string before it is logged or stored. */
  readonly redact: (value: string) => string;
}

export class Client extends Context.Service<Client, ClientShape>()(
  "Ssh.Client",
) {}

const RC_MARKER = "__alchemy_ssh_rc=";
const SUDO_MARKER = "__alchemy_ssh_sudo";
// macOS caps a Unix socket path at 104 bytes; `%C` expands to 40 and OpenSSH
// may add a 17-byte suffix.
const CONTROL_PATH_LIMIT = 104 - 40 - 17;

/** POSIX single-quote. */
export const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * `export` lines for `env`. They are sent ahead of the command's stdin rather
 * than on the command line, where they would show up in `ps` and sudo's log.
 */
export const envPayload = (env: ExecOptions["env"] = {}) =>
  new TextEncoder().encode(
    Object.entries(env)
      .map(
        ([name, value]) =>
          `export ${name}=${quote(typeof value === "string" ? value : Redacted.value(value))}\n`,
      )
      .join(""),
  );

/**
 * The remote side of one `exec`: env (read from stdin), `cd` and the command
 * under one shell (and one `sudo`), then the exit-code sentinel. Under `sudo`
 * a marker is printed first, so a refused `sudo` is told apart from the
 * command failing.
 */
export const remoteScript = (
  command: string,
  options: Pick<ExecOptions, "sudo" | "cwd" | "env" | "shell"> = {},
) => {
  const env = envPayload(options.env).length;
  const lines = [
    ...(options.sudo ? [`printf '%s\\n' ${SUDO_MARKER}`] : []),
    ...(env === 0 ? [] : [`eval "$(dd bs=1 count=${env} 2>/dev/null)"`]),
    ...(options.cwd === undefined ? [] : [`cd ${quote(options.cwd)} || exit`]),
    command,
  ];
  const script = `${options.shell ?? "sh"} -c ${quote(lines.join("\n"))}`;
  return `${options.sudo ? `sudo -n -H ${script}` : script}; printf '\\n${RC_MARKER}%d\\n' "$?"`;
};

/** Split the sentinel off stdout; `undefined` when the shell never reported. */
const parseSentinel = (stdout: string) => {
  const at = stdout.lastIndexOf(`\n${RC_MARKER}`);
  if (at === -1) return undefined;
  const code = Number.parseInt(stdout.slice(at + 1 + RC_MARKER.length), 10);
  return Number.isNaN(code) ? undefined : { code, stdout: stdout.slice(0, at) };
};

/** Why a session never reached the remote shell, from what `ssh` printed. */
const sessionFailure = (input: {
  host: string;
  user: string;
  code: number;
  stderr: string;
}): SessionError => {
  const detail = `ssh exited ${input.code}: ${input.stderr.trim() || "no output"}`;
  if (
    input.stderr.includes("Host key verification failed") ||
    input.stderr.includes("REMOTE HOST IDENTIFICATION HAS CHANGED")
  ) {
    return new HostKeyMismatch({ message: detail, ...input });
  }
  if (input.stderr.includes("Permission denied (")) {
    return new AuthenticationFailed({ message: detail, ...input });
  }
  return new ConnectionLost({ message: detail, ...input });
};

const HOST_KEY_ARGS: Record<HostKeyPolicy, string[]> = {
  strict: ["-o", "StrictHostKeyChecking=yes"],
  "accept-new": ["-o", "StrictHostKeyChecking=accept-new"],
  off: ["-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null"],
};

/**
 * Open a session against one host over the system `ssh`/`scp` binaries. The
 * key is written 0600 into a temp directory that lives as long as the scope.
 */
export const connect = Effect.fn("Ssh.connect")(function* (
  options: ConnectOptions,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const { host, user } = options;
  const dest = `${user}@${host}`;
  // scp needs an IPv6 address in brackets.
  const scpDest = host.includes(":") ? `${user}@[${host}]` : dest;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-ssh-" });

  const secrets = new Map(
    (options.secrets ?? []).map((secret) => [Redacted.value(secret), secret]),
  );
  let redactor = makeCommandRedactor(Object.fromEntries(secrets));
  const learn = (values: ReadonlyArray<unknown>) => {
    let grew = false;
    for (const value of values) {
      if (
        Redacted.isRedacted(value) &&
        typeof Redacted.value(value) === "string"
      ) {
        const plain = Redacted.value(value) as string;
        if (!secrets.has(plain)) {
          secrets.set(plain, value as Redacted.Redacted<string>);
          grew = true;
        }
      }
    }
    if (grew) redactor = makeCommandRedactor(Object.fromEntries(secrets));
  };
  const redact = (value: string) => redactor.redact(value);

  const keyArgs: string[] = [];
  if (options.privateKey !== undefined) {
    const keyPath = path.join(dir, "id");
    yield* fs.writeFileString(
      keyPath,
      `${Redacted.value(options.privateKey).trimEnd()}\n`,
    );
    yield* fs.chmod(keyPath, 0o600);
    keyArgs.push("-i", keyPath);
    if (options.identitiesOnly !== false) {
      keyArgs.push("-o", "IdentitiesOnly=yes");
    }
  }

  const controlPath =
    `${dir}/cm-%C`.length - 2 <= CONTROL_PATH_LIMIT
      ? `${dir}/cm-%C`
      : "/tmp/alchemy-ssh-%C";
  const commonArgs = [
    "-o",
    "BatchMode=yes",
    "-o",
    `ConnectTimeout=${Duration.toSeconds(options.connectTimeout ?? "10 seconds")}`,
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "LogLevel=ERROR",
    ...HOST_KEY_ARGS[options.hostKeyPolicy ?? "accept-new"],
    ...keyArgs,
    ...(options.multiplex
      ? [
          "-o",
          "ControlMaster=auto",
          "-o",
          `ControlPath=${controlPath}`,
          "-o",
          "ControlPersist=60s",
        ]
      : []),
  ];
  const port = String(options.port ?? 22);
  const sshArgs = [...commonArgs, "-p", port];
  const scpArgs = [...commonArgs, "-P", port];

  const run = (bin: "ssh" | "scp", args: string[], stdin?: Uint8Array) =>
    spawner
      .spawn(
        ChildProcess.make(bin, args, {
          stdin: stdin === undefined ? "ignore" : Stream.make(stdin),
          stdout: "pipe",
          stderr: "pipe",
          detached: false,
        }),
      )
      .pipe(
        Effect.flatMap((child) =>
          Effect.all(
            {
              code: Effect.map(child.exitCode, Number),
              stdout: child.stdout.pipe(Stream.decodeText, Stream.mkString),
              stderr: child.stderr.pipe(Stream.decodeText, Stream.mkString),
            },
            { concurrency: "unbounded" },
          ),
        ),
        Effect.scoped,
        Effect.mapError(
          (error) =>
            new SpawnError({
              message: `${bin} could not be started: ${error.message}`,
              host,
              bin,
            }),
        ),
      );

  const exec: ClientShape["exec"] = (command, execOptions = {}) =>
    Effect.gen(function* () {
      const invalid = Object.keys(execOptions.env ?? {}).filter(
        (name) => !ENV_NAME.test(name),
      );
      if (invalid.length > 0) {
        return yield* new InvalidEnvName({
          message: `invalid environment variable name: ${invalid.join(", ")}`,
          names: invalid,
        });
      }
      learn(Object.values(execOptions.env ?? {}));
      const env = envPayload(execOptions.env);
      const input =
        typeof execOptions.stdin === "string"
          ? new TextEncoder().encode(execOptions.stdin)
          : execOptions.stdin;
      const stdin =
        env.length === 0 && input === undefined
          ? undefined
          : new Uint8Array([...env, ...(input ?? [])]);
      const spawned = run(
        "ssh",
        [...sshArgs, dest, "--", remoteScript(command, execOptions)],
        stdin,
      );
      const raw = yield* execOptions.timeout === undefined
        ? spawned
        : spawned.pipe(
            Effect.timeoutOrElse({
              duration: execOptions.timeout,
              orElse: () =>
                Effect.fail(
                  new ExecTimeout({
                    message: `remote command did not finish within ${Duration.format(Duration.fromInputUnsafe(execOptions.timeout!))}`,
                    host,
                    command: redact(command),
                    timeout: Duration.format(
                      Duration.fromInputUnsafe(execOptions.timeout!),
                    ),
                  }),
                ),
            }),
          );
      const reported = parseSentinel(raw.stdout);
      if (reported === undefined) {
        return yield* sessionFailure({
          host,
          user,
          code: raw.code,
          stderr: redact(raw.stderr),
        });
      }
      if (!execOptions.sudo) {
        return { ...reported, stderr: raw.stderr };
      }
      if (!reported.stdout.startsWith(`${SUDO_MARKER}\n`)) {
        return yield* new SudoRefused({
          message: `sudo -n refused to run as root: ${redact(raw.stderr.trim()) || "no output"}`,
          host,
          user,
          stderr: redact(raw.stderr),
        });
      }
      return {
        code: reported.code,
        stdout: reported.stdout.slice(SUDO_MARKER.length + 1),
        stderr: raw.stderr,
      };
    }).pipe(
      Effect.withSpan("Ssh.exec", {
        attributes: { host, command: redact(command) },
      }),
    );

  const transferFailed = (input: {
    local: string;
    remote: string;
    code: number;
    stderr: string;
  }) =>
    new TransferError({
      message: redact(
        `scp exited ${input.code}: ${input.stderr.trim() || "no output"}`,
      ),
      host,
      ...input,
      stderr: redact(input.stderr),
    });

  const upload: ClientShape["upload"] = (local, remote) =>
    Effect.gen(function* () {
      let localPath = typeof local === "string" ? local : undefined;
      if (localPath === undefined) {
        const staged = path.join(
          dir,
          `upload-${yield* Effect.sync(() => crypto.randomUUID())}`,
        );
        yield* Effect.acquireRelease(
          fs.writeFile(staged, local as Uint8Array),
          () => fs.remove(staged, { force: true }).pipe(Effect.ignore),
        ).pipe(
          Effect.mapError((error) =>
            transferFailed({
              local: staged,
              remote,
              code: -1,
              stderr: error.message,
            }),
          ),
        );
        localPath = staged;
      }
      const parent = remote.slice(0, remote.lastIndexOf("/"));
      if (parent !== "") {
        const made = yield* exec(`mkdir -p ${quote(parent)}`);
        if (made.code !== 0) {
          return yield* transferFailed({
            local: localPath,
            remote,
            code: made.code,
            stderr: made.stderr,
          });
        }
      }
      const result = yield* run("scp", [
        ...scpArgs,
        localPath,
        `${scpDest}:${remote}`,
      ]);
      if (result.code !== 0) {
        return yield* transferFailed({ local: localPath, remote, ...result });
      }
    }).pipe(
      Effect.scoped,
      Effect.withSpan("Ssh.upload", { attributes: { host, remote } }),
    );

  const ping: ClientShape["ping"] = run("ssh", [
    ...sshArgs,
    dest,
    "--",
    "true",
  ]).pipe(
    Effect.flatMap((result) =>
      result.code === 0
        ? Effect.void
        : Effect.fail(
            sessionFailure({
              host,
              user,
              code: result.code,
              stderr: redact(result.stderr),
            }),
          ),
    ),
    Effect.withSpan("Ssh.ping", { attributes: { host } }),
  );

  // Close the multiplexed master, if any.
  const reset = options.multiplex
    ? run("ssh", [...sshArgs, "-O", "exit", dest]).pipe(Effect.ignore)
    : Effect.void;

  yield* Effect.addFinalizer(() => reset);

  return {
    host,
    user,
    exec,
    upload,
    ping,
    redact,
  } satisfies ClientShape;
});

export type ConnectServices =
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path
  | Scope.Scope;

/**
 * Ping until the remote shell answers. A server that was just created answers
 * some time after its API reports it running. Authentication and host-key
 * failures are not retried.
 */
export const waitForSsh = (
  client: Pick<ClientShape, "host" | "ping">,
  options: {
    timeout: Duration.Input;
    /** @default "5 seconds" */
    interval?: Duration.Input;
  },
) =>
  client.ping.pipe(
    Effect.retry({
      while: (error) => error._tag === "Ssh.ConnectionLost",
      schedule: Schedule.spaced(options.interval ?? "5 seconds").pipe(
        Schedule.upTo({ duration: options.timeout }),
      ),
    }),
    Effect.withSpan("Ssh.waitForSsh", { attributes: { host: client.host } }),
  );
