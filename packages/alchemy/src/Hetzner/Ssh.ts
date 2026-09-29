import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import * as Redacted from "effect/Redacted";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as Binding from "../Binding.ts";
import { connect } from "../Ssh/Client.ts";
import type {
  ExecError as SshTransportError,
  TransferError,
} from "../Ssh/Errors.ts";
import type { Server } from "./Server.ts";

export class SshError extends Data.TaggedError("Hetzner.SshError")<{
  message: string;
  host?: string;
  command?: string;
  code?: number;
  stderr?: string;
}> {}

export interface SshExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface SshOptions {
  /** SSH user. @default "root" */
  user?: string;
  /** PKCS8 PEM private key. Defaults to the Server's deploy key. */
  privateKey?: string | Redacted.Redacted<string>;
}

export type SshServices =
  | FileSystem.FileSystem
  | Path.Path
  | ChildProcessSpawner.ChildProcessSpawner
  | Scope.Scope;

export interface SshClient {
  exec: (
    command: string,
  ) => Effect.Effect<SshExecResult, SshError, SshServices>;
  scp: (
    local: string | Uint8Array<ArrayBufferLike>,
    remote: string,
  ) => Effect.Effect<void, SshError, SshServices>;
}

/**
 * SSH exec/scp against a Hetzner Server. Uses the Server's Alchemy-managed
 * deploy key (injected at create) unless `privateKey` is passed.
 *
 * ### Remote access
 * **Example:** Exec a command
 * ```typescript
 * const ssh = yield* Hetzner.Ssh(server);
 * const { stdout } = yield* ssh.exec("uname -a");
 * ```
 *
 * **Example:** Copy a file
 * ```typescript
 * const ssh = yield* Hetzner.Ssh(server);
 * yield* ssh.scp("/tmp/app.zip", "/opt/app/bundle.zip");
 * ```
 *
 * @binding
 * @product Server
 */
export interface Ssh extends Binding.Service<
  Ssh,
  "Hetzner.Ssh",
  (
    server: Server,
    options?: SshOptions,
  ) => Effect.Effect<SshClient, SshError, SshServices>
> {}

export const Ssh = Binding.Service<Ssh>("Hetzner.Ssh");

const unwrapKey = (value: unknown): string | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  if (Redacted.isRedacted(value)) {
    const inner = Redacted.value(value);
    return typeof inner === "string" ? inner : undefined;
  }
  return undefined;
};

const ipv4Of = (server: Server): string | undefined => {
  const value = (server as { ipv4?: unknown }).ipv4;
  return typeof value === "string" && value.length > 0 ? value : undefined;
};

const toSshError =
  (host: string) =>
  (error: SshTransportError | TransferError | PlatformError) =>
    new SshError({
      message: error.message,
      host,
      command: "command" in error ? error.command : undefined,
      stderr: "stderr" in error ? error.stderr : undefined,
    });

/**
 * Open an SSH session against `host` with the given private key, over
 * {@link connect}. Commands run under bash and fail on a non-zero exit.
 */
export const openSshClient = Effect.fn(function* (input: {
  host: string;
  privateKey: string;
  user?: string;
}) {
  const scope = yield* Scope.make();
  const client = yield* connect({
    host: input.host,
    user: input.user ?? "root",
    privateKey: Redacted.make(input.privateKey),
    hostKeyPolicy: "off",
  }).pipe(
    Scope.provide(scope),
    Effect.onError(() => Scope.close(scope, Exit.void)),
    Effect.mapError(toSshError(input.host)),
  );

  const exec = (command: string) =>
    client.exec(command, { shell: "bash" }).pipe(
      Effect.mapError(toSshError(input.host)),
      Effect.flatMap((result) =>
        result.code === 0
          ? Effect.succeed(result)
          : Effect.fail(
              new SshError({
                message: `ssh exited ${result.code}: ${
                  [result.stderr, result.stdout]
                    .map((s) => s.trim())
                    .filter((s) => s.length > 0)
                    .join("\n") || "no output"
                }`,
                host: input.host,
                command,
                code: result.code,
                stderr: result.stderr,
              }),
            ),
      ),
    );

  const scp = (local: string | Uint8Array<ArrayBufferLike>, remote: string) =>
    client.upload(local, remote).pipe(Effect.mapError(toSshError(input.host)));

  return {
    exec,
    scp,
    close: Scope.close(scope, Exit.void),
  } satisfies SshClient & { close: Effect.Effect<void> };
});

export const sshClientForServer = Effect.fn(function* (
  server: Server,
  options?: SshOptions,
) {
  const host = ipv4Of(server);
  if (host === undefined) {
    return yield* new SshError({
      message: `Server '${server.LogicalId}' has no public IPv4 address`,
    });
  }
  const privateKey =
    unwrapKey(options?.privateKey) ??
    unwrapKey((server as { privateKey?: unknown }).privateKey);
  if (privateKey === undefined) {
    return yield* new SshError({
      message: `Server '${server.LogicalId}' has no deploy SSH private key`,
      host,
    });
  }
  return yield* openSshClient({
    host,
    privateKey,
    user: options?.user,
  }).pipe(
    Effect.mapError((error) =>
      error instanceof SshError
        ? error
        : new SshError({
            message: `ssh failed: ${String(error)}`,
            host,
          }),
    ),
  );
});

export const SshLive = Layer.effect(
  Ssh,
  Effect.succeed(
    Effect.fn(function* (server: Server, options?: SshOptions) {
      const session = yield* sshClientForServer(server, options);
      yield* Effect.addFinalizer(() => session.close);
      return {
        exec: session.exec,
        scp: session.scp,
      };
    }),
  ),
);
