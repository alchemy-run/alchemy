/**
 * First-class React hooks for talking to agent runs — the client half
 * of the run-socket protocol ({@link RunSocketTransport}), packaged
 * the way a UI wants to consume it:
 *
 * ```tsx
 * import { useAgent, useChat } from "alchemy/AI/React";
 *
 * function IssueChannel({ url }: { url: string }) {
 *   const agent = useAgent({ url }); // wss://…/attach/Scribe/issue-7
 *   const { messages, sendMessage, status } = useChat({ agent });
 *   // …render with ai-elements / your own components
 * }
 * ```
 *
 * `useChat` IS the Vercel AI SDK's `useChat` — same return shape,
 * same ecosystem compatibility (ai-elements etc.) — pre-wired with
 * the agent's socket transport instead of HTTP POST + SSE. It works
 * against ANY kernel that provides `AI.AgentGateway`: the in-memory
 * kernel serving from a local process and the Cloudflare kernel
 * serving from a run's own Durable Object speak the identical
 * protocol.
 *
 * This module lives at `alchemy/AI/React` (not the `alchemy/AI`
 * barrel) so server-side consumers of the AI module never pull
 * `react` into a Worker or Lambda bundle.
 */
import { useChat as useAiChat } from "@ai-sdk/react";
import type { UIMessage } from "ai";
import { useMemo } from "react";
import { RunSocketTransport } from "./RunSocket.ts";

export interface UseAgentOptions {
  /** The run's attach endpoint: `ws(s)://host/attach/{term}/{key}`. */
  readonly url: string;
}

/** A connection to ONE agent run — hand it to {@link useChat}. */
export interface AgentConnection {
  readonly url: string;
  readonly transport: RunSocketTransport;
}

/**
 * Connect to an agent run over its WebSocket. The connection is
 * memoized per URL and opened lazily on the first send.
 */
export const useAgent = (options: UseAgentOptions): AgentConnection => {
  const url = options.url;
  return useMemo(
    () => ({ url, transport: new RunSocketTransport({ url }) }),
    [url],
  );
};

export type UseChatOptions = Omit<
  NonNullable<Parameters<typeof useAiChat<UIMessage>>[0]>,
  "transport"
> & {
  readonly agent: AgentConnection;
};

/**
 * The AI SDK's `useChat`, speaking to an agent run: submits go down
 * the run socket as inputs, and the run's observations come back as
 * `UIMessageChunk`s.
 */
export const useChat = ({ agent, ...options }: UseChatOptions) =>
  useAiChat<UIMessage>({ ...options, transport: agent.transport });
