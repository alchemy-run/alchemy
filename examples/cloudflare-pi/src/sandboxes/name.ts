import type * as AI from "@alchemy.run/ai";

/** The conversation's sandbox name: lowercase letters, digits and `-`, as every platform accepts. */
export const sandboxName = ({ instanceId, conversationId }: AI.SandboxTarget) =>
  `pi-${instanceId.slice(0, 16)}-${conversationId}`;
