/**
 * The WebSockets an actor activation accepted, over RivetKit's raw
 * WebSockets (`onWebSocket`).
 *
 * @internal
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type { WebSocket } from "../WebSocket.ts";

/** The least of a RivetKit raw WebSocket the registry needs. */
export interface RawWebSocket {
  binaryType: string;
  readonly readyState: number;
  send(data: string | ArrayBuffer | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (event: any) => void): void;
}

/** The WebSocket of the upgrade the current `fetch` serves, which it may accept. */
export class PendingWebSocket extends Context.Service<
  PendingWebSocket,
  { readonly accept: (tags: ReadonlyArray<string>) => Effect.Effect<WebSocket> }
>()("Rivet.PendingWebSocket") {}

export interface SocketRegistry {
  /** Track an accepted socket until it closes. */
  readonly add: (ws: RawWebSocket, tags: ReadonlyArray<string>) => WebSocket;
  readonly remove: (socket: WebSocket) => void;
  readonly all: (tag?: string) => ReadonlyArray<WebSocket>;
}

const OPEN = 1;

export const makeSocketRegistry = (): SocketRegistry => {
  const open = new Set<WebSocket>();
  return {
    add: (ws, tags) => {
      let attachment: unknown = null;
      const socket: WebSocket = {
        tags,
        send: (data) =>
          Effect.sync(() => {
            if (ws.readyState === OPEN) ws.send(data);
          }),
        close: (code, reason) =>
          Effect.sync(() => {
            open.delete(socket);
            if (ws.readyState <= OPEN) ws.close(code, reason);
          }),
        serializeAttachment: (value) => {
          attachment = value === undefined ? null : structuredClone(value);
        },
        deserializeAttachment: <T>() =>
          (attachment === null ? null : structuredClone(attachment)) as T | null,
      };
      open.add(socket);
      return socket;
    },
    remove: (socket) => void open.delete(socket),
    all: (tag) => [...open].filter((socket) => tag === undefined || socket.tags.includes(tag)),
  };
};
