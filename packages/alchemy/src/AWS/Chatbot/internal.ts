import type * as chatbot from "@distilled.cloud/aws/chatbot";
import * as Redacted from "effect/Redacted";

/**
 * Unwrap a Chatbot `SensitiveString` (decoded as `Redacted`) to its plain
 * string value.
 */
export const unredact = (value: string | Redacted.Redacted<string>): string =>
  Redacted.isRedacted(value) ? Redacted.value(value) : value;

/**
 * Convert a plain tag map to the Chatbot wire `Tag` list
 * (`{ TagKey, TagValue }`).
 */
export const toChatbotTags = (tags: Record<string, string>): chatbot.Tag[] =>
  Object.entries(tags).map(([TagKey, TagValue]) => ({ TagKey, TagValue }));

/**
 * Convert an observed Chatbot wire `Tag` list to a plain tag map.
 */
export const fromChatbotTags = (
  tags: readonly chatbot.Tag[] | undefined,
): Record<string, string> =>
  Object.fromEntries((tags ?? []).map((t) => [t.TagKey, t.TagValue]));
