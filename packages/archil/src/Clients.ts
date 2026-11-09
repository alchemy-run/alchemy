/**
 * The run-time handles Archil bindings return. A disk or sandbox handle is
 * the same shape whether it came from a deploy-time resource
 * (`ExecDisk(Dataset)`, `ConnectSandbox(Preview)`) or was created at run
 * time (`CreateDisk`, `CreateSandbox`), and takes Archil's own parameters.
 */
import * as archil from "@distilled.cloud/archil";
import * as Objects from "@distilled.cloud/archil/Objects";
import * as Process from "@distilled.cloud/archil/Process";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as SandboxBase from "alchemy/Sandbox";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type { Authorize, ObjectsRunner } from "./ArchilBindings.ts";
import type { BranchAttributes } from "./Branch.ts";
import { ensureBranch, toBranchAttributes } from "./Branch.ts";
import type { DiskAttributes } from "./Disk.ts";
import type { DiskUserAttributes } from "./DiskUser.ts";
import {
  addDiskUser,
  removeDiskUser,
  type DiskUserSpec,
  type DiskUserUnexpectedResponse,
} from "./DiskUser.ts";
import { deleteSandbox, observeSandbox, type SandboxAttributes } from "./Sandbox.ts";
import { toEgressPolicy, type SandboxEgress } from "./SandboxOptions.ts";
import type { SandboxPortTokenAttributes } from "./SandboxPortToken.ts";
import { createPortToken, revokePortToken } from "./SandboxPortToken.ts";

type R = RuntimeContext;

/** What a serverless exec printed, and its exit code. */
export interface ExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  /** Where the time went, as Archil reports it. */
  readonly timing: archil.ExecTiming;
}

/** Search options for `grep`. */
export interface GrepOptions {
  /** Directory on the disk to search. @default "/" */
  readonly directory?: string;
  /** Regular expression. */
  readonly pattern: string;
  /** Search subdirectories. @default false */
  readonly recursive?: boolean;
  /** Stop after this many seconds. @default 30 */
  readonly maxDurationSeconds?: number;
  /** Workers to fan out to. @default 50 */
  readonly concurrency?: number;
  /** Stop after this many matches. @default 1000 */
  readonly maxResults?: number;
}

/** Serverless commands and search against one disk. */
export interface ExecDiskClient {
  /**
   * Run a shell command in a fresh microVM with the disk mounted at
   * `/mnt/archil`. Blocks until it exits (up to five minutes).
   */
  exec(command: string): Effect.Effect<ExecResult, archil.ExecDiskError, R>;
  /** Constant-time parallel grep across the disk's files. */
  grep(options: GrepOptions): Effect.Effect<archil.GrepDiskResult, archil.GrepDiskError, R>;
}

/** Read the disk's files as objects. */
export interface ReadDiskClient {
  /** A file's bytes, optionally a byte range (`bytes=0-1023`). */
  get(
    key: string,
    options?: { readonly range?: string },
  ): Effect.Effect<Uint8Array, Objects.ObjectsFailure | ObjectsTransportError, R>;
  /** A file as UTF-8 text. */
  getText(key: string): Effect.Effect<string, Objects.ObjectsFailure | ObjectsTransportError, R>;
  /** A file's bytes as a stream, for files too big to hold in memory. */
  getStream(
    key: string,
  ): Stream.Stream<Uint8Array, Objects.ObjectsFailure | ObjectsTransportError, R>;
  /** A file's metadata, or `undefined` when it doesn't exist. */
  head(
    key: string,
  ): Effect.Effect<
    Objects.ObjectMetadata | undefined,
    Objects.ObjectsFailure | ObjectsTransportError,
    R
  >;
  /** Every file under a prefix, lazily paginated. */
  list(
    prefix?: string,
    options?: { readonly recursive?: boolean },
  ): Stream.Stream<Objects.ObjectSummary, Objects.ObjectsFailure | ObjectsTransportError, R>;
  /**
   * A signed URL anyone can download one file from, valid for
   * `expiresInSeconds` (1 to 604800; default one hour).
   */
  share(
    key: string,
    expiresInSeconds?: number,
  ): Effect.Effect<Redacted.Redacted<string>, ShareError, R>;
}

/** What creating a share URL can fail with. */
export type ShareError =
  | archil.CreateShareUrlError
  | Effect.Error<ReturnType<typeof Objects.presignGetObject>>;

/** Write the disk's files as objects. */
export interface WriteDiskClient {
  /** Write a file (≤ 5 GiB). */
  put(
    key: string,
    body: Uint8Array | string,
    options?: { readonly contentType?: string } & Objects.PosixAttributes,
  ): Effect.Effect<{ etag: string | undefined }, Objects.ObjectsFailure | ObjectsTransportError, R>;
  /** Append to a file, creating it when missing (≤ 1 MiB per call). */
  append(
    key: string,
    body: Uint8Array | string,
  ): Effect.Effect<{ etag: string | undefined }, Objects.ObjectsFailure | ObjectsTransportError, R>;
  /** Delete a file. Deleting a missing file succeeds. */
  delete(key: string): Effect.Effect<void, Objects.ObjectsFailure | ObjectsTransportError, R>;
  /** Delete many files; per-file failures are returned. */
  deleteMany(keys: ReadonlyArray<string>): Effect.Effect<
    {
      deleted: string[];
      errors: Array<{ readonly key: string; readonly code?: string; readonly message?: string }>;
    },
    Objects.ObjectsFailure | ObjectsTransportError,
    R
  >;
  /** Copy a file within the disk. */
  copy(
    sourceKey: string,
    key: string,
  ): Effect.Effect<{ etag: string | undefined }, Objects.ObjectsFailure | ObjectsTransportError, R>;
  /**
   * Write a file of any size from a stream, as a multipart upload in
   * 8 MiB parts. A failed upload is aborted, so no parts are left behind.
   */
  upload<E>(
    key: string,
    body: Stream.Stream<Uint8Array, E>,
    options?: { readonly contentType?: string } & Objects.PosixAttributes,
  ): Effect.Effect<
    { etag: string | undefined },
    Objects.ObjectsFailure | ObjectsTransportError | E,
    R
  >;
}

/** Write delegations on a disk: the paths a mounted client holds for writing. */
export interface DiskDelegationsClient {
  /** Write delegations held on the disk, e.g. by a crashed mount. */
  delegations(): Effect.Effect<archil.DelegationEntry[], archil.ListDelegationsError, R>;
  /** Reclaim write access from a client that is gone. */
  revokeDelegation(
    delegation: Pick<archil.DelegationEntry, "clientId" | "inodeId">,
  ): Effect.Effect<void, archil.RevokeDelegationError, R>;
}

/** Both {@link ReadDiskClient} and {@link WriteDiskClient}. */
export interface ReadWriteDiskClient extends ReadDiskClient, WriteDiskClient {}

/** Errors from the HTTP transport underneath the objects API. */
export type ObjectsTransportError = Effect.Error<ReturnType<typeof Objects.headObject>>;

/** Branches of one disk. */
export interface BranchDiskClient {
  /**
   * Create a writable branch from a committed checkpoint, or return the
   * branch with that name.
   */
  branch(options: {
    readonly name: string;
    readonly fromCheckpoint: string;
    readonly fromBranch?: string;
  }): Effect.Effect<BranchAttributes, archil.CreateBranchError | archil.GetBranchError, R>;
  /** A branch, or `undefined` when it doesn't exist. */
  getBranch(name: string): Effect.Effect<BranchAttributes | undefined, archil.GetBranchError, R>;
  /** Every branch of the disk, including branches of branches. */
  listBranches(): Effect.Effect<BranchAttributes[], archil.ListBranchesError, R>;
}

/** One disk, with everything a run-time client can do to it. */
export interface DiskHandle
  extends ExecDiskClient, ReadWriteDiskClient, BranchDiskClient, DiskDelegationsClient {
  readonly diskId: string;
  readonly name: string;
  /**
   * A disk token for mounting this disk only, e.g. to hand to a machine
   * that mounts with `MountDisk()`. `readOnly`, `expiresAt` and `oneUse`
   * narrow it. Revoke it with `removeToken`.
   */
  createToken(
    nickname: string,
    options?: Pick<DiskUserSpec, "readOnly" | "expiresAt" | "oneUse">,
  ): Effect.Effect<DiskUserAttributes, archil.AddDiskUserError | DiskUserUnexpectedResponse, R>;
  /** Revoke a disk token. */
  removeToken(identifier: string): Effect.Effect<void, archil.RemoveDiskUserError, R>;
}

/** A command: one shell line, or an argument vector (quoted for you). */
export type Command = SandboxBase.Command;

/** Options for a command run in a sandbox (`timeout` rounds up to whole seconds). */
export type ExecOptions = SandboxBase.ExecOptions;

/** Options for a process started in the background. */
export type StartOptions = Omit<ExecOptions, "stdin">;

/**
 * What a process call on a sandbox handle can fail with. A paused sandbox
 * is resumed first, so resuming can fail too.
 */
export type ProcessCallError =
  | Process.ProcessError
  | archil.CreateSandboxConnectionError
  | archil.GetSandboxError
  | archil.ResumeSandboxError;

/** A chunk of process output, with its offset in the combined output (for `attach`). */
export interface SandboxProcessOutput extends SandboxBase.ProcessOutput {
  readonly offset: number;
}

/** How an Archil process ended. */
export interface SandboxProcessExit {
  /**
   * The exit code. Archil reports none for a process it killed (a timeout,
   * or `kill`); that is `-1` here, and `status` / `exitReason` say why.
   */
  readonly exitCode: number;
  readonly status: string;
  readonly exitReason: string | undefined;
  /** Output offset at exit, for a later `attach`. */
  readonly cursor: number;
}

/**
 * A process running in a sandbox, attached over one connection. Closing
 * the scope that started it detaches; the process keeps running and can be
 * re-attached by `id`.
 */
export interface SandboxProcess extends SandboxBase.Process<ProcessCallError> {
  readonly output: Stream.Stream<SandboxProcessOutput, ProcessCallError, R>;
  /**
   * Kill the process. Archil's process API kills without a choice of
   * signal, so `signal` is ignored.
   */
  kill(signal?: "SIGTERM" | "SIGKILL"): Effect.Effect<void, ProcessCallError, R>;
  readonly wait: Effect.Effect<SandboxProcessExit, ProcessCallError, R>;
  /** Close stdin. */
  readonly closeStdin: Effect.Effect<void, ProcessCallError, R>;
}

/** A shell (or command) on a pseudo-terminal. */
export interface PtyConnection extends SandboxBase.PtyConnection<ProcessCallError> {
  /** Kill the terminal's process. */
  kill(): Effect.Effect<void, ProcessCallError, R>;
  /** Wait for the terminal's process to exit. */
  readonly wait: Effect.Effect<SandboxProcessExit, ProcessCallError, R>;
}

/** Options for a pseudo-terminal. `command` may also be an argument vector. */
export interface PtyOptions extends Omit<SandboxBase.PtyOptions, "command"> {
  /** @default "bash" */
  readonly command?: Command;
}

/**
 * Files in the sandbox. Archil's process protocol has no file calls of its
 * own: these run small POSIX shell commands over it (as Archil's own SDK
 * does for uploads and downloads), so they work on any image with `sh`,
 * `cat`, `stat`, `rm` and `mkdir`.
 */
export interface SandboxFiles extends SandboxBase.Files<ProcessCallError> {
  /** Write a file (atomically: a temp file, then a rename), creating its directory. */
  write(
    path: string,
    data: string | Uint8Array,
    options?: { readonly mode?: number },
  ): Effect.Effect<void, ProcessCallError, R>;
}

/** The sandbox doesn't serve this port publicly (`exposePort` it first). */
export class SandboxPortNotExposed extends Data.TaggedError("Archil.SandboxPortNotExposed")<{
  readonly port: number;
  readonly message: string;
}> {}

/** Why `getTcpPort` can fail. */
export type SandboxPortError = SandboxPortNotExposed | archil.ListSandboxPortsError;

/**
 * A port the sandbox serves publicly, at its own `archil.app` hostname.
 * `fetch` sends a client request there, or proxies the server request a
 * handler received; either way the method, path, query, headers and body
 * are kept. Anyone with the URL can call a public port, so hand browsers a
 * port token (`createPortToken`) rather than your key.
 */
export interface SandboxPort extends SandboxBase.SandboxPort<SandboxPortError> {
  /** The port inside the sandbox. */
  readonly port: number;
  /** Archil's public hostname for this port, e.g. `3000-<route>.<zone>.archil.app`. */
  readonly hostname: string;
  /** `https://` + `hostname`. */
  readonly url: string;
}

/** Everything a run-time client can do to one sandbox. */
export interface SandboxOps
  extends
    SandboxBase.SandboxExec<ProcessCallError, Process.ProcessResult, ExecOptions>,
    SandboxBase.SandboxProcesses<ProcessCallError, StartOptions>,
    SandboxBase.SandboxFiles<ProcessCallError>,
    SandboxBase.SandboxPty<ProcessCallError, PtyOptions>,
    SandboxBase.SandboxPorts<SandboxPortError, SandboxPort> {
  /** The sandbox's current attributes. */
  refresh(): Effect.Effect<SandboxAttributes, archil.GetSandboxError, R>;
  /**
   * Run a command to completion and collect its output. A non-zero exit is
   * returned in `exitCode`, not failed.
   */
  exec(
    command: Command,
    options?: ExecOptions,
  ): Effect.Effect<Process.ProcessResult, ProcessCallError, R>;
  /**
   * Start a command in the background and attach to it. Closing the scope
   * detaches; the process keeps running and can be re-attached by id.
   */
  start(
    command: Command,
    options?: StartOptions,
  ): Effect.Effect<SandboxProcess, ProcessCallError, R | Scope.Scope>;
  /** Re-attach to a running process, resuming its output at `offset`. */
  attach(
    processId: string,
    offset?: number,
  ): Effect.Effect<SandboxProcess, ProcessCallError, R | Scope.Scope>;
  /** Files in the sandbox. */
  readonly files: SandboxFiles;
  /** Pseudo-terminals. */
  readonly pty: {
    /** Open a shell (or `command`) on a terminal of `cols` × `rows`. */
    open(options: PtyOptions): Effect.Effect<PtyConnection, ProcessCallError, R | Scope.Scope>;
  };
  /**
   * A port the sandbox serves publicly. Fails with `SandboxPortNotExposed`
   * until the port is exposed (`ports` on the resource, or `exposePort`).
   */
  getTcpPort(port: number): Effect.Effect<SandboxPort, SandboxPortError, R>;
  /** Start a stopped sandbox (Archil's `start`). */
  boot(): Effect.Effect<SandboxAttributes, archil.StartSandboxError, R>;
  /** Stop the sandbox (its disk survives; memory doesn't). */
  stop(): Effect.Effect<SandboxAttributes, archil.StopSandboxError, R>;
  /** Pause the sandbox, keeping its memory. */
  pause(): Effect.Effect<SandboxAttributes, archil.PauseSandboxError, R>;
  /** Resume a paused sandbox. */
  resume(): Effect.Effect<SandboxAttributes, archil.ResumeSandboxError, R>;
  /**
   * Fork the sandbox (memory and disk) into a new one. Archil only forks a
   * sandbox with mounts while it is stopped.
   */
  fork(options?: {
    readonly name?: string;
    readonly checkpoint?: string;
  }): Effect.Effect<SandboxHandle, archil.ForkSandboxError, R>;
  /**
   * Pause after `timeoutSeconds` from now, and/or after `idleTtlSeconds`
   * without a connection (`0` disables idle expiry).
   */
  setTimeout(options: {
    readonly timeoutSeconds?: number;
    readonly idleTtlSeconds?: number;
  }): Effect.Effect<SandboxAttributes, archil.SetSandboxTimeoutError, R>;
  /** Serve a port publicly. */
  exposePort(
    port: number,
  ): Effect.Effect<{ port: number; hostname: string }, archil.ExposeSandboxPortError, R>;
  /** Stop serving a port. */
  unexposePort(port: number): Effect.Effect<void, archil.DeleteSandboxPortError, R>;
  /** Ports the sandbox serves. */
  ports(): Effect.Effect<
    Array<{ port: number; hostname: string }>,
    archil.ListSandboxPortsError,
    R
  >;
  /** A token that opens one port for a client that shouldn't hold an API key. */
  createPortToken(
    port: number,
    ttl?: string,
  ): Effect.Effect<SandboxPortTokenAttributes, archil.CreateSandboxPortTokenError, R>;
  /** Revoke a port token. */
  revokePortToken(tokenId: string): Effect.Effect<void, archil.DeleteSandboxPortTokenError, R>;
  /**
   * The sandbox's port tokens, without their secret values (Archil only
   * shows a token when it's created).
   */
  listPortTokens(): Stream.Stream<archil.SandboxPortToken, archil.ListSandboxPortTokensError, R>;
  /** Replace the outbound network policy. Applies at once. */
  setEgress(egress: SandboxEgress): Effect.Effect<void, archil.UpdateSandboxNetworkError, R>;
  /**
   * Stop (if it's live) and delete the sandbox. Deleting a missing sandbox
   * succeeds.
   */
  delete(): Effect.Effect<void, Effect.Error<ReturnType<typeof deleteSandbox>>, R>;
}

/** One sandbox known by id and name, with everything a run-time client can do to it. */
export interface SandboxHandle extends SandboxOps {
  readonly sandboxId: string;
  readonly name: string;
}

const toExecResult = (data: archil.ExecDiskResult): ExecResult => ({
  exitCode: data.exitCode,
  stdout: data.stdout,
  stderr: data.stderr,
  timing: data.timing,
});

const unwrapToken = (value: string | Redacted.Redacted<string>) =>
  typeof value === "string" ? Redacted.make(value) : value;

/** Serverless exec + grep on a disk whose id resolves at run time. */
export const makeExecDiskClient = (
  diskId: Effect.Effect<string, never, R>,
  authorize: Authorize,
): ExecDiskClient => ({
  exec: (command) =>
    authorize(
      Effect.gen(function* () {
        const id = yield* diskId;
        const { data } = yield* archil.execDisk({ id, command });
        return toExecResult(data);
      }),
    ),
  grep: (options) =>
    authorize(
      Effect.gen(function* () {
        const { data } = yield* archil.grepDisk({
          id: yield* diskId,
          directory: options.directory ?? "/",
          pattern: options.pattern,
          recursive: options.recursive,
          maxDurationSeconds: options.maxDurationSeconds,
          concurrency: options.concurrency,
          maxResults: options.maxResults,
        });
        return data;
      }),
    ),
});

/** How a read client makes share URLs. */
export type ShareStrategy = (
  ref: Objects.DiskRef,
  key: string,
  expiresInSeconds: number,
) => Effect.Effect<Redacted.Redacted<string>, ShareError, R>;

/** Share URLs presigned with the client's own S3 user keys. */
export const presignedShare =
  (run: ObjectsRunner): ShareStrategy =>
  (ref, key, expiresInSeconds) =>
    run(Objects.presignGetObject(ref, key, expiresInSeconds)).pipe(Effect.map(Redacted.make));

/** Share URLs from Archil's control plane (needs the API key). */
export const controlPlaneShare =
  (authorize: Authorize): ShareStrategy =>
  (ref, key, expiresInSeconds) =>
    authorize(
      Effect.gen(function* () {
        const { data } = yield* archil.createShareUrl({
          id: ref.disk,
          key,
          expiresIn: expiresInSeconds,
        });
        return unwrapToken(data.url);
      }),
    );

/** Object reads on a disk (or branch) whose id resolves at run time. */
export const makeReadDiskClient = (
  ref: Effect.Effect<Objects.DiskRef, never, R>,
  run: ObjectsRunner,
  share: ShareStrategy,
): ReadDiskClient => ({
  get: (key, options) => run(Effect.flatMap(ref, (r) => Objects.getObject(r, key, options))),
  getText: (key) => run(Effect.flatMap(ref, (r) => Objects.getObjectText(r, key))),
  getStream: (key) =>
    run.stream(Stream.unwrap(Effect.map(ref, (r) => Objects.getObjectStream(r, key)))),
  head: (key) => run(Effect.flatMap(ref, (r) => Objects.headObject(r, key))),
  list: (prefix, options) =>
    run.stream(
      Stream.unwrap(
        Effect.map(ref, (r) => Objects.listObjects(r, prefix, { recursive: options?.recursive })),
      ),
    ),
  share: (key, expiresInSeconds = 3600) =>
    Effect.flatMap(ref, (r) => share(r, key, expiresInSeconds)),
});

const PART_SIZE = 8 * 1024 * 1024;

const concatBytes = (chunks: ReadonlyArray<Uint8Array>) => {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
};

/** Object writes on a disk (or branch) whose id resolves at run time. */
export const makeWriteDiskClient = (
  ref: Effect.Effect<Objects.DiskRef, never, R>,
  run: ObjectsRunner,
): WriteDiskClient => ({
  put: (key, body, options) =>
    run(Effect.flatMap(ref, (r) => Objects.putObject(r, key, body, options))),
  append: (key, body) => run(Effect.flatMap(ref, (r) => Objects.appendObject(r, key, body))),
  delete: (key) => run(Effect.flatMap(ref, (r) => Objects.deleteObject(r, key))),
  deleteMany: (keys) => run(Effect.flatMap(ref, (r) => Objects.deleteObjects(r, keys))),
  copy: (sourceKey, key) =>
    run(
      Effect.flatMap(ref, (r) => Objects.copyObject(r, sourceKey, key)).pipe(
        Effect.map(({ etag }) => ({ etag })),
      ),
    ),
  upload: (key, body, options) =>
    run(
      Effect.gen(function* () {
        const r = yield* ref;
        const { uploadId } = yield* Objects.createMultipartUpload(r, key, options);
        const parts: Array<{ readonly partNumber: number; readonly etag: string }> = [];
        const sendPart = (bytes: Uint8Array) =>
          Objects.uploadPart(r, key, uploadId, parts.length + 1, bytes).pipe(
            Effect.map((part) => void parts.push(part)),
          );
        return yield* Effect.gen(function* () {
          const rest = yield* Stream.runFoldEffect(
            body,
            (): ReadonlyArray<Uint8Array> => [],
            (pending, chunk) => {
              const next = [...pending, chunk];
              const size = next.reduce((n, c) => n + c.byteLength, 0);
              if (size < PART_SIZE) return Effect.succeed(next);
              const bytes = concatBytes(next);
              return Effect.as(sendPart(bytes.subarray(0, PART_SIZE)), [bytes.subarray(PART_SIZE)]);
            },
          );
          const last = concatBytes(rest);
          // S3 needs at least one part; an empty body is one empty part.
          if (last.byteLength > 0 || parts.length === 0) yield* sendPart(last);
          return yield* Objects.completeMultipartUpload(r, key, uploadId, parts);
        }).pipe(
          Effect.onError(() => Objects.abortMultipartUpload(r, key, uploadId).pipe(Effect.ignore)),
          Effect.map(({ etag }) => ({ etag })),
        );
      }),
    ),
});

/** Write delegations on a disk whose id resolves at run time (needs the API key). */
export const makeDiskDelegationsClient = (
  ref: Effect.Effect<Objects.DiskRef, never, R>,
  authorize: Authorize,
): DiskDelegationsClient => ({
  delegations: () =>
    authorize(
      Effect.gen(function* () {
        const { disk } = yield* ref;
        const { data } = yield* archil.listDelegations({ id: disk });
        return data.delegations;
      }),
    ),
  revokeDelegation: (delegation) =>
    authorize(
      Effect.gen(function* () {
        const { disk } = yield* ref;
        yield* archil.revokeDelegation({
          id: disk,
          clientId: delegation.clientId,
          inodeId: delegation.inodeId,
        });
      }),
    ),
});

/** Branches of a disk whose id resolves at run time. */
export const makeBranchDiskClient = (
  diskId: Effect.Effect<string, never, R>,
  authorize: Authorize,
): BranchDiskClient => ({
  branch: (options) =>
    authorize(
      Effect.gen(function* () {
        const id = yield* diskId;
        return yield* ensureBranch({
          disk: id,
          name: options.name,
          fromCheckpoint: options.fromCheckpoint,
          fromBranch: options.fromBranch,
        });
      }),
    ),
  getBranch: (name) =>
    authorize(
      Effect.gen(function* () {
        const id = yield* diskId;
        return yield* archil.getBranch({ id, name }).pipe(
          Effect.map(({ data }) => toBranchAttributes(data)),
          Effect.catchTag("NotFound", () => Effect.undefined),
        );
      }),
    ),
  listBranches: () =>
    authorize(
      Effect.gen(function* () {
        const id = yield* diskId;
        const { data } = yield* archil.listBranches({ id });
        return data.map(toBranchAttributes);
      }),
    ),
});

/** A full handle on a disk known by id and name. */
export const makeDiskHandle = (
  disk: Pick<DiskAttributes, "diskId" | "name">,
  authorize: Authorize,
): DiskHandle => {
  const diskId = Effect.succeed(disk.diskId);
  const ref = Effect.succeed({ disk: disk.diskId } satisfies Objects.DiskRef);
  return {
    diskId: disk.diskId,
    name: disk.name,
    ...makeExecDiskClient(diskId, authorize),
    ...makeReadDiskClient(ref, authorize.objects, controlPlaneShare(authorize)),
    ...makeWriteDiskClient(ref, authorize.objects),
    ...makeDiskDelegationsClient(ref, authorize),
    ...makeBranchDiskClient(diskId, authorize),
    createToken: (nickname, options) =>
      authorize(addDiskUser(disk.diskId, { nickname, ...options })),
    removeToken: (identifier) =>
      authorize(removeDiskUser({ diskId: disk.diskId, type: "token", identifier })),
  };
};

/** Single-quote a value for `sh`. */
const shellQuote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;

const commandLine = (command: Command) =>
  typeof command === "string" ? command : command.map(shellQuote).join(" ");

const runOptions = (options: StartOptions | undefined): Process.RunOptions => ({
  cwd: options?.cwd,
  env: options?.env === undefined ? undefined : { ...options.env },
  timeoutSeconds:
    options?.timeout === undefined ? undefined : Math.ceil(Duration.toSeconds(options.timeout)),
});

const utf8 = new TextDecoder();

const toExit = (exit: Process.ProcessExit): SandboxProcessExit => ({
  exitCode: exit.exitCode ?? -1,
  status: exit.status,
  exitReason: exit.exitReason,
  cursor: exit.cursor,
});

const entryType = (kind: string): SandboxBase.FileEntry["type"] =>
  kind.includes("directory")
    ? "directory"
    : kind.includes("symbolic link")
      ? "symlink"
      : kind.includes("regular")
        ? "file"
        : "other";

/** Parse `stat -c '%F\t%s\t%n'` lines; names are joined to `dir` when given. */
const parseEntries = (out: string, dir: string | undefined): SandboxBase.FileEntry[] =>
  out
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const [kind = "", size = "0", ...name] = line.split("\t");
      const base = name.join("\t");
      return {
        path: dir === undefined ? base : `${dir.replace(/\/+$/, "")}/${base}`,
        type: entryType(kind),
        size: Number(size),
      };
    });

/**
 * Everything a run-time client can do to the sandbox `sid` resolves to.
 * `forkName` maps a fork's name (a binding puts its owner prefix on it,
 * like on the sandboxes it creates).
 */
export const makeSandboxOps = (
  sid: Effect.Effect<string, never, R>,
  authorize: Authorize,
  forkName: (name: string | undefined) => Effect.Effect<string | undefined> = Effect.succeed,
): SandboxOps => {
  // A paused sandbox (idle TTL) refuses process connections with
  // `sandbox_terminated`; resume it and try once more.
  const awake = <A, E extends { readonly _tag: string }, R2>(
    use: (sid: string) => Effect.Effect<A, E, R2>,
  ) =>
    authorize(
      Effect.flatMap(sid, (id) =>
        use(id).pipe(
          Effect.catchIf(
            (e) => e._tag === "SandboxTerminated",
            (e) =>
              archil
                .getSandbox({ sid: id })
                .pipe(
                  Effect.flatMap(({ data }) =>
                    data.status === "paused"
                      ? archil.resumeSandbox({ sid: id, wait: true }).pipe(Effect.andThen(use(id)))
                      : Effect.fail(e),
                  ),
                ),
          ),
        ),
      ),
    );
  const call = <A, E, R2>(use: (sid: string) => Effect.Effect<A, E, R2>) =>
    authorize(Effect.flatMap(sid, use));
  const attrs = <E, R2>(use: (sid: string) => Effect.Effect<{ data: archil.Sandbox }, E, R2>) =>
    call((id) => use(id).pipe(Effect.flatMap(({ data }) => observeSandbox(data))));
  const toProcess = (process: Process.Process): SandboxProcess => ({
    id: process.id,
    output: process.output.pipe(
      Stream.map((chunk) => ({ fd: chunk.stream, data: chunk.data, offset: chunk.offset })),
    ),
    write: (data) => process.write(data),
    closeStdin: process.closeStdin,
    kill: () => awake((id) => Process.kill(id, process.id)),
    wait: Effect.map(process.exit, toExit),
  });
  // A shell command whose non-zero exit is a failure with its stderr.
  const sh = (command: string, what: string) =>
    awake((id) => Process.exec(id, command)).pipe(
      Effect.flatMap((result) =>
        result.exitCode === 0
          ? Effect.succeed(result.stdout)
          : Effect.fail(
              Process.ProcessError.make({
                message: `${what} failed (exit ${result.exitCode ?? result.status}): ${result.stderr.trim()}`,
              }),
            ),
      ),
    );
  const files: SandboxFiles = {
    read: (path) => awake((id) => Process.downloadFile(id, path)),
    readText: (path) =>
      awake((id) => Process.downloadFile(id, path)).pipe(Effect.map((bytes) => utf8.decode(bytes))),
    write: (path, data, options) => awake((id) => Process.uploadFile(id, path, data, options)),
    list: (path) =>
      sh(
        `cd ${shellQuote(path)} && for f in * .[!.]* ..?*; do [ -e "$f" ] || [ -L "$f" ] || continue; stat -c '%F\t%s\t%n' -- "$f"; done`,
        `list ${path}`,
      ).pipe(Effect.map((out) => parseEntries(out, path))),
    stat: (path) =>
      sh(`stat -c '%F\t%s\t%n' -- ${shellQuote(path)}`, `stat ${path}`).pipe(
        Effect.map((out) => ({ ...parseEntries(out, undefined)[0]!, path })),
      ),
    remove: (path) => sh(`rm -rf -- ${shellQuote(path)}`, `remove ${path}`).pipe(Effect.asVoid),
    makeDir: (path) => sh(`mkdir -p -- ${shellQuote(path)}`, `makeDir ${path}`).pipe(Effect.asVoid),
  };
  const ops: SandboxOps = {
    refresh: () => attrs((id) => archil.getSandbox({ sid: id })),
    exec: (command, options) =>
      options?.stdin === undefined
        ? awake((id) => Process.exec(id, commandLine(command), runOptions(options)))
        : awake((id) =>
            Effect.scoped(
              Effect.gen(function* () {
                const process = yield* Process.run(id, commandLine(command), runOptions(options));
                yield* process.write(options.stdin!);
                yield* process.closeStdin;
                const out = new TextDecoder();
                const err = new TextDecoder();
                let stdout = "";
                let stderr = "";
                yield* process.output.pipe(
                  Stream.runForEach((chunk) =>
                    Effect.sync(() => {
                      if (chunk.stream === "stdout")
                        stdout += out.decode(chunk.data, { stream: true });
                      else stderr += err.decode(chunk.data, { stream: true });
                    }),
                  ),
                );
                const exit = yield* process.exit;
                return {
                  ...exit,
                  stdout: stdout + out.decode(),
                  stderr: stderr + err.decode(),
                } satisfies Process.ProcessResult;
              }),
            ),
          ),
    start: (command, options) =>
      awake((id) => Process.run(id, commandLine(command), runOptions(options))).pipe(
        Effect.map(toProcess),
      ),
    attach: (processId, offset) =>
      awake((id) => Process.attach(id, processId, offset)).pipe(Effect.map(toProcess)),
    files,
    pty: {
      open: (options) =>
        awake((id) =>
          Process.run(id, commandLine(options.command ?? "bash"), {
            cwd: options.cwd,
            env: options.env === undefined ? undefined : { ...options.env },
            terminal: { cols: options.cols, rows: options.rows },
          }),
        ).pipe(
          Effect.map((process): PtyConnection => ({
            id: process.id,
            output: process.output.pipe(Stream.map((chunk) => chunk.data)),
            write: (data) => process.write(data),
            resize: (size) => awake((id) => Process.resize(id, process.id, size)),
            kill: () => awake((id) => Process.kill(id, process.id)),
            wait: Effect.map(process.exit, toExit),
          })),
        ),
    },
    getTcpPort: (port) =>
      call((id) =>
        Effect.gen(function* () {
          const { data } = yield* archil.listSandboxPorts({ sid: id });
          const endpoint = (data.ports ?? []).find((p) => p.port === port);
          if (endpoint === undefined) {
            return yield* new SandboxPortNotExposed({
              port,
              message: `Port ${port} isn't served publicly; call exposePort(${port}) first.`,
            });
          }
          const url = `https://${endpoint.hostname}`;
          // Archil's edge routes by hostname, so the caller's Host header
          // (a Worker's own, when proxying) is replaced by the port's.
          const send = (request: HttpClientRequest.HttpClientRequest) => {
            const source = new URL(request.url, "http://sandbox");
            return HttpClient.HttpClient.pipe(
              Effect.flatMap((client) =>
                client.execute(
                  request.pipe(
                    HttpClientRequest.setUrl(`${url}${source.pathname}${source.search}`),
                    HttpClientRequest.removeHeader("host"),
                  ),
                ),
              ),
              Effect.provide(FetchHttpClient.layer),
            );
          };
          return {
            port,
            hostname: endpoint.hostname,
            url,
            fetch: SandboxBase.portFetch<SandboxPortError>(send),
          } satisfies SandboxPort;
        }),
      ),
    boot: () => attrs((id) => archil.startSandbox({ sid: id, wait: true })),
    stop: () => attrs((id) => archil.stopSandbox({ sid: id })),
    pause: () => attrs((id) => archil.pauseSandbox({ sid: id })),
    resume: () => attrs((id) => archil.resumeSandbox({ sid: id })),
    fork: (options) =>
      call((id) =>
        forkName(options?.name).pipe(
          Effect.flatMap((name) =>
            archil.forkSandbox({ sid: id, wait: true, name, checkpoint: options?.checkpoint }),
          ),
        ),
      ).pipe(
        Effect.map(({ data }) =>
          makeSandboxHandle({ sandboxId: data.sandbox_id, name: data.name }, authorize, forkName),
        ),
      ),
    setTimeout: (options) =>
      attrs((id) =>
        archil.setSandboxTimeout({
          sid: id,
          timeout: options.timeoutSeconds,
          idle_ttl_seconds: options.idleTtlSeconds,
        }),
      ),
    exposePort: (port) =>
      call((id) => archil.exposeSandboxPort({ sid: id, port })).pipe(
        Effect.map(({ data }) => ({ port: data.port, hostname: data.hostname })),
      ),
    unexposePort: (port) =>
      call((id) => archil.deleteSandboxPort({ sid: id, port })).pipe(Effect.asVoid),
    ports: () =>
      call((id) => archil.listSandboxPorts({ sid: id })).pipe(
        Effect.map(({ data }) =>
          (data.ports ?? []).map((p) => ({ port: p.port, hostname: p.hostname })),
        ),
      ),
    createPortToken: (port, ttl) => call((id) => createPortToken(id, port, ttl)),
    revokePortToken: (tokenId) => call((id) => revokePortToken(id, tokenId)),
    listPortTokens: () =>
      authorize.stream(
        Stream.unwrap(
          Effect.map(sid, (id) =>
            Stream.paginate(undefined as string | undefined, (cursor) =>
              archil
                .listSandboxPortTokens({ sid: id, cursor })
                .pipe(
                  Effect.map(
                    ({ data, nextCursor }) =>
                      [data.tokens, Option.fromNullishOr(nextCursor)] as const,
                  ),
                ),
            ),
          ),
        ),
      ),
    setEgress: (egress) =>
      call((id) => archil.updateSandboxNetwork({ sid: id, egress: toEgressPolicy(egress) })).pipe(
        Effect.asVoid,
      ),
    delete: () => call((id) => deleteSandbox(id)),
  };
  return ops;
};

/** A full handle on a sandbox known by id and name. */
export const makeSandboxHandle = (
  sandbox: { readonly sandboxId: string; readonly name: string },
  authorize: Authorize,
  forkName?: (name: string | undefined) => Effect.Effect<string | undefined>,
): SandboxHandle => ({
  sandboxId: sandbox.sandboxId,
  name: sandbox.name,
  ...makeSandboxOps(Effect.succeed(sandbox.sandboxId), authorize, forkName),
});
