import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type {
  Sandbox,
  SandboxEntry,
  SandboxExecOptions,
  SandboxExecResult,
  SandboxPty,
} from "./Sandbox.ts";
import type { SandboxPtyRpc } from "./SandboxPty.ts";

/**
 * The flat, by-name RPC surface a sandbox GUEST serves — the {@link
 * Sandbox} contract with its nested `pty` group flattened into the
 * {@link SandboxPtyRpc} methods. Every remote sandbox (the AWS MicroVM
 * guest, the Cloudflare Container guest, the dev-mode host server) is
 * the SAME physics behind this one shape; the client-side layers differ
 * only in how they reach a machine.
 */
export interface SandboxRpcShape extends SandboxPtyRpc {
  readonly exec: (
    command: string,
    args?: ReadonlyArray<string>,
    options?: SandboxExecOptions,
  ) => Effect.Effect<SandboxExecResult, string>;
  readonly readFile: (path: string) => Effect.Effect<string, string>;
  readonly writeFile: (
    path: string,
    content: string,
  ) => Effect.Effect<void, string>;
  readonly deleteFile: (path: string) => Effect.Effect<void, string>;
  readonly mkdir: (path: string) => Effect.Effect<void, string>;
  readonly listFiles: (
    path?: string,
  ) => Effect.Effect<ReadonlyArray<SandboxEntry>, string>;
  readonly exists: (path: string) => Effect.Effect<boolean, string>;
}

/**
 * How long the guest holds an idle `ptyRead` before answering empty.
 * Under the guest's own 8s ceiling and every proxy's idle-reap window.
 */
export const PTY_POLL_WAIT_MS = 7_000;

/** The contract methods that ride the RPC shape 1:1 (no lifecycle — a
 *  machine's lifecycle is the connecting layer's business). */
export type SandboxOverRpc = Pick<
  Sandbox["Service"],
  | "exec"
  | "readFile"
  | "writeFile"
  | "deleteFile"
  | "mkdir"
  | "listFiles"
  | "exists"
> & { readonly pty: SandboxPty };

/** Render any wire-layer error as the contract's string. */
export const errorText = (error: unknown): string =>
  typeof error === "string" ? error : String(error);

/**
 * The {@link Sandbox} contract over a flat {@link SandboxRpcShape}
 * stub. `withStub` resolves the stub PER CALL (the connecting layer
 * decides which machine the calling session addresses, and may
 * relaunch/reconnect around the call); `ptyId` optionally rewrites PTY
 * ids per call, so sessions sharing ONE machine keep separate shells.
 *
 * The PTY stream is a LONG-POLL splice, not a streaming response:
 * ingress proxies on the path to a guest fully buffer response bodies,
 * which would hold an infinite stream's bytes hostage until EOF. Each
 * `ptyRead` is finite (ends the instant output exists, or empty after
 * {@link PTY_POLL_WAIT_MS} of silence), so every hop forwards it; the
 * unfold splices the polls back into one Stream.
 */
export const sandboxOverRpc = (
  withStub: <A, E>(
    use: (stub: SandboxRpcShape) => Effect.Effect<A, E>,
  ) => Effect.Effect<A, E>,
  options?: {
    readonly ptyId?: (id: string) => Effect.Effect<string>;
  },
): SandboxOverRpc => {
  const ptyId = options?.ptyId ?? Effect.succeed;
  const withPty = <A, E>(
    id: string,
    use: (stub: SandboxRpcShape, id: string) => Effect.Effect<A, E>,
  ): Effect.Effect<A, E> =>
    Effect.flatMap(ptyId(id), (scoped) =>
      withStub((stub) => use(stub, scoped)),
    );

  return {
    exec: (command, args, execOptions) =>
      withStub((stub) => stub.exec(command, args, execOptions)),
    readFile: (path) => withStub((stub) => stub.readFile(path)),
    writeFile: (path, content) =>
      withStub((stub) => stub.writeFile(path, content)),
    deleteFile: (path) => withStub((stub) => stub.deleteFile(path)),
    mkdir: (path) => withStub((stub) => stub.mkdir(path)),
    listFiles: (path) => withStub((stub) => stub.listFiles(path)),
    exists: (path) => withStub((stub) => stub.exists(path)),
    pty: {
      open: (id, cols, rows) =>
        withPty(id, (stub, id) => stub.ptyOpen(id, cols, rows)),
      stream: (id) =>
        Stream.unfold(0, (cursor: number) =>
          withPty(id, (stub, id) =>
            stub.ptyRead(id, cursor, PTY_POLL_WAIT_MS),
          ).pipe(
            Effect.map((result) =>
              result.done
                ? undefined
                : ([joinChunks(result.b64), result.nextSeq] as const),
            ),
            Effect.mapError(errorText),
          ),
        ).pipe(Stream.filter((bytes) => bytes.byteLength > 0)),
      input: (id, data) => withPty(id, (stub, id) => stub.ptyInput(id, data)),
      resize: (id, cols, rows) =>
        withPty(id, (stub, id) => stub.ptyResize(id, cols, rows)),
      close: (id) => withPty(id, (stub, id) => stub.ptyClose(id)),
    },
  };
};

const fromBase64 = (b64: string): Uint8Array => {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
};

/** Concatenate one poll's chunks into a single write. */
const joinChunks = (b64: ReadonlyArray<string>): Uint8Array => {
  const parts = b64.map(fromBase64);
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
};
