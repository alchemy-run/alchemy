import * as Data from "effect/Data";

/** The `ssh`/`scp` binary could not be started. */
export class SpawnError extends Data.TaggedError("Ssh.SpawnError")<{
  message: string;
  host: string;
  bin: string;
}> {}

/**
 * The session dropped before the remote command reported its exit code. The
 * only transport failure worth retrying.
 */
export class ConnectionLost extends Data.TaggedError("Ssh.ConnectionLost")<{
  message: string;
  host: string;
  stderr: string;
}> {}

/** The server refused every offered key. Not retried. */
export class AuthenticationFailed extends Data.TaggedError(
  "Ssh.AuthenticationFailed",
)<{
  message: string;
  host: string;
  user: string;
  stderr: string;
}> {}

/** The host key does not match `known_hosts`. Not retried. */
export class HostKeyMismatch extends Data.TaggedError("Ssh.HostKeyMismatch")<{
  message: string;
  host: string;
  stderr: string;
}> {}

/** `sudo -n` refused to run the command, e.g. it needs a password. */
export class SudoRefused extends Data.TaggedError("Ssh.SudoRefused")<{
  message: string;
  host: string;
  user: string;
  stderr: string;
}> {}

/** An `env` key is not a valid shell variable name. */
export class InvalidEnvName extends Data.TaggedError("Ssh.InvalidEnvName")<{
  message: string;
  names: string[];
}> {}

/** The remote command outlived its `timeout`. */
export class ExecTimeout extends Data.TaggedError("Ssh.ExecTimeout")<{
  message: string;
  host: string;
  command: string;
  timeout: string;
}> {}

/** `scp` exited non-zero. */
export class TransferError extends Data.TaggedError("Ssh.TransferError")<{
  message: string;
  host: string;
  local: string;
  remote: string;
  code: number;
  stderr: string;
}> {}

/** Failures that stop a session from reaching the remote shell. */
export type SessionError =
  | SpawnError
  | ConnectionLost
  | AuthenticationFailed
  | HostKeyMismatch;

export type ExecError =
  | SessionError
  | SudoRefused
  | ExecTimeout
  | InvalidEnvName;
