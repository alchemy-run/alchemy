import type * as Pi from "@alchemy.run/pi";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

/**
 * What a conversation's sandbox is keyed on. Conversation ids repeat from
 * one Durable Object to the next, so the object's id is part of the key.
 */
export type SandboxKey = Pick<Pi.EnvTarget, "instanceId" | "conversationId">;

/** The conversation's sandbox name: lowercase letters, digits and `-`, as every platform accepts. */
export const sandboxName = ({ instanceId, conversationId }: SandboxKey) =>
  `pi-${instanceId.slice(0, 16)}-${conversationId}`;

/**
 * Deletes a conversation's sandbox. `Pi.Sandbox` finds or creates one;
 * this is its other half, which each platform spells differently.
 */
export class RemoveSandbox extends Context.Service<
  RemoveSandbox,
  (key: SandboxKey) => Effect.Effect<void, unknown, RuntimeContext>
>()("RemoveSandbox") {}
