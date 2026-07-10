import type * as Prompt from "effect/unstable/ai/Prompt";

/**
 * Project an AI work item or run result into readable prose.
 *
 * This is deliberately NOT `String(value)` or blind `JSON.stringify`:
 * conversation work items are arrays of `Prompt.Message` objects, and
 * `String(messages)` produces `[object Object],[object Object]`. The
 * deterministic-process path receives those same typed work items, so
 * coordinators must use the same canonical projection as the kernel.
 *
 * Rules:
 * - strings pass through;
 * - Prompt message arrays become a role-labelled transcript;
 * - Agent `Completed` outcomes become their final text;
 * - primitives are readable;
 * - other structured values use indented JSON as an honest fallback.
 */
export const toPromptText = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (
    typeof value === "object" &&
    value !== null &&
    (value as { _tag?: unknown })._tag === "Completed" &&
    typeof (value as { text?: unknown }).text === "string"
  ) {
    return (value as { text: string }).text;
  }
  if (isPromptMessages(value)) {
    return value
      .flatMap((message) => {
        const text = messageText(message);
        return text.length === 0
          ? []
          : [`${message.role.toUpperCase()}:\n${text}`];
      })
      .join("\n\n");
  }
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return String(value);
  }
  if (value === undefined) return "";
  try {
    return JSON.stringify(value, undefined, 2);
  } catch {
    return Object.prototype.toString.call(value);
  }
};

const isPromptMessages = (
  value: unknown,
): value is ReadonlyArray<Prompt.Message> =>
  Array.isArray(value) &&
  value.every(
    (entry) =>
      typeof entry === "object" &&
      entry !== null &&
      "role" in entry &&
      "content" in entry,
  );

const messageText = (message: Prompt.Message): string => {
  if (typeof message.content === "string") return message.content;
  return message.content
    .flatMap((part) => {
      if (
        typeof part === "object" &&
        part !== null &&
        "text" in part &&
        typeof part.text === "string"
      ) {
        return [part.text];
      }
      return [];
    })
    .join("");
};
