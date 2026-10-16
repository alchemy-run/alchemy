/**
 * The wire protocol `exec` speaks over a socket into a sandbox that runs
 * Alchemy's bootstrap (a MicroVM, any process host): the client is
 * `execOverSocket` (`AI/SandboxExec.ts`), the server `serveExec`
 * (`Runtime/Bootstrap/ExecServer.ts`).
 *
 * Every frame is binary, a channel byte then its payload, so it means the
 * same whatever a transport does with text frames (Node delivers them as
 * Buffers). Control messages are JSON on the control channel.
 *
 * @internal
 */

export const ExecChannel = {
  stdin: 0,
  stdout: 1,
  stderr: 2,
  control: 3,
} as const;
export type ExecChannel = (typeof ExecChannel)[keyof typeof ExecChannel];

/** Client → server, first: what to run. */
export interface ExecStart {
  readonly _tag: "Start";
  readonly cmd: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  readonly user?: string;
  /** Whether stdin frames follow (then `Eof`); otherwise stdin is closed. */
  readonly stdin: boolean;
  readonly stdout: "pipe" | "ignore";
  readonly stderr: "pipe" | "ignore" | "combined";
}

export type ExecControl =
  | ExecStart
  /** Server → client: the process started. */
  | { readonly _tag: "Started"; readonly pid: number }
  /** Client → server: stdin is complete. */
  | { readonly _tag: "Eof" }
  /** Client → server: signal the process. */
  | { readonly _tag: "Kill"; readonly signal?: number }
  /** Server → client, last: the exit code (128 + signal when killed). */
  | { readonly _tag: "Exit"; readonly code: number }
  /** Server → client, last: the process couldn't start. */
  | { readonly _tag: "Failed"; readonly message: string };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const encodeData = (channel: ExecChannel, payload: Uint8Array): Uint8Array => {
  const frame = new Uint8Array(payload.length + 1);
  frame[0] = channel;
  frame.set(payload, 1);
  return frame;
};

export const encodeControl = (message: ExecControl): Uint8Array =>
  encodeData(ExecChannel.control, encoder.encode(JSON.stringify(message)));

export type ExecFrame =
  | { readonly channel: typeof ExecChannel.control; readonly message: ExecControl }
  | { readonly channel: 0 | 1 | 2; readonly data: Uint8Array };

/** Decode one frame; `undefined` for a malformed one. */
export const decodeFrame = (frame: Uint8Array | string): ExecFrame | undefined => {
  const bytes = typeof frame === "string" ? encoder.encode(frame) : frame;
  if (bytes.length === 0) return undefined;
  const channel = bytes[0]!;
  const payload = bytes.subarray(1);
  if (channel === ExecChannel.control) {
    try {
      const message = JSON.parse(decoder.decode(payload)) as ExecControl;
      return typeof message?._tag === "string" ? { channel, message } : undefined;
    } catch {
      return undefined;
    }
  }
  return channel === 0 || channel === 1 || channel === 2 ? { channel, data: payload } : undefined;
};
