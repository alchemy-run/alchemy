import type * as Pi from "@alchemy.run/pi";

/** The conversation's sandbox name: lowercase letters, digits and `-`, as every platform accepts. */
export const sandboxName = ({ instanceId, conversationId }: Pi.SandboxKey) =>
  `pi-${instanceId.slice(0, 16)}-${conversationId}`;
