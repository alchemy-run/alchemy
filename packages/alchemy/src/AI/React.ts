/**
 * First-class React hooks for talking to agent sessions — the client half
 * of the session-socket protocol ({@link SessionSocketTransport}), packaged
 * the way a UI wants to consume it:
 *
 * ```tsx
 * import { useAgent, useChat } from "alchemy/AI/React";
 *
 * function IssueChannel({ chatId }: { chatId: string }) {
 *   const agent = useAgent({ chatId }); // → wss://…/attach/IssueOwner/…
 *   const { messages, sendMessage, status } = useChat({
 *     agent,
 *     resume: true, // subscribe on mount; re-subscribe after each burst
 *   });
 * }
 * ```
 *
 * `useChat` IS the Vercel AI SDK's `useChat` — same return shape,
 * same ecosystem compatibility (ai-elements etc.) — pre-wired with
 * the agent's socket transport instead of HTTP POST + SSE. It works
 * against ANY driver that provides `AI.SessionSockets`: the in-memory
 * driver serving from a local process and the Cloudflare driver
 * serving from a session's own Durable Object speak the identical
 * protocol.
 *
 * This module lives at `alchemy/AI/React` (not the `alchemy/AI`
 * barrel) so server-side consumers of the AI module never pull
 * `react` into a Worker or Lambda bundle.
 */
import { useChat as useAiChat } from "@ai-sdk/react";
import type { ChatInit, UIMessage } from "ai";
import { useEffect, useMemo } from "react";
import { chatId as makeChatId } from "./Chats.ts";
import { SessionSocketTransport } from "./EventStream.ts";

/**
 * Build the session-socket URL for a chat id (`${term}:${key}`) or an
 * explicit `{ term, key }`. Keys may contain `/` — each path segment
 * is encoded so the Worker's rest-join parser recovers them.
 */
export const attachUrl = (
  target: string | { readonly term: string; readonly key: string },
  host: {
    readonly protocol?: string;
    readonly host?: string;
  } = globalThis.location,
): string => {
  const { term, key } =
    typeof target === "string"
      ? (() => {
          const at = target.indexOf(":");
          if (at < 0) {
            throw new Error(
              `attachUrl: chat id must be term:key, got ${target}`,
            );
          }
          return { term: target.slice(0, at), key: target.slice(at + 1) };
        })()
      : target;
  const proto = (host.protocol ?? "https:").startsWith("https")
    ? "wss:"
    : "ws:";
  const hostname = host.host ?? "localhost";
  const keyPath = key
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `${proto}//${hostname}/attach/${encodeURIComponent(term)}/${keyPath}`;
};

export interface UseAgentOptions {
  /** Absolute `ws(s)://` attach URL — or omit and pass {@link chatId}. */
  readonly url?: string;
  /** Chat id (`${term}:${key}`) — converted via {@link attachUrl}. */
  readonly chatId?: string;
  readonly term?: string;
  readonly key?: string;
  /**
   * What the first subscribe requests: `"replay"` (default) streams
   * the full durable history; `"live"` tails only — pass it when the
   * transcript is hydrated from a snapshot (`/messages`), or every
   * historical message arrives a second time over the socket.
   */
  readonly history?: "replay" | "live";
}

/** A connection to ONE agent session — hand it to {@link useChat}. */
export interface AgentConnection {
  readonly url: string;
  readonly transport: SessionSocketTransport;
}

/**
 * Connect to an agent session over its WebSocket. The connection is
 * memoized per URL; {@link useChat} with `resume: true` opens it on
 * mount via `reconnectToStream`.
 */
export const useAgent = (options: UseAgentOptions): AgentConnection => {
  const url = useMemo(() => {
    if (options.url) return options.url;
    if (options.chatId) return attachUrl(options.chatId);
    if (options.term !== undefined && options.key !== undefined) {
      return attachUrl({ term: options.term, key: options.key });
    }
    throw new Error("useAgent: pass url, chatId, or term+key");
  }, [options.url, options.chatId, options.term, options.key]);
  const history = options.history;
  return useMemo(
    () => ({ url, transport: new SessionSocketTransport({ url, history }) }),
    [url, history],
  );
};

export type UseChatOptions = Omit<ChatInit<UIMessage>, "transport"> & {
  readonly agent: AgentConnection;
  /**
   * Keep the live view open across park/quiesce bursts: after each
   * stream ends, call `resumeStream` again. Defaults to `true`.
   */
  readonly persist?: boolean;
  /** Subscribe on mount (the AI SDK's `resume`). Defaults to `true`. */
  readonly resume?: boolean;
  readonly experimental_throttle?: number;
};

/**
 * The AI SDK's `useChat`, speaking to an agent session: submits go down
 * the session socket as inputs, and the session's observations come back as
 * `UIMessageChunk`s. With `persist` (default), the socket re-subscribes
 * after every burst so a parked IssueOwner keeps streaming.
 */
export const useChat = ({
  agent,
  persist = true,
  resume = true,
  ...options
}: UseChatOptions) => {
  const chat = useAiChat<UIMessage>({
    ...options,
    resume,
    transport: agent.transport,
  });

  useEffect(() => {
    if (!persist) return;
    if (chat.status !== "ready") return;
    void chat.resumeStream();
  }, [persist, chat.status, chat.resumeStream]);

  return chat;
};

export { makeChatId as chatId };
