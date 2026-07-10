import { describe, expect, it } from "@effect/vitest";
import * as Prompt from "effect/unstable/ai/Prompt";
import { toPromptText } from "@/AI/Text.ts";

describe("kernel prompt text projection", () => {
  it("projects Prompt.Message[] as readable role-labelled history", () => {
    const messages = [
      Prompt.makeMessage("user", {
        content: [Prompt.makePart("text", { text: "default timeout?" })],
      }),
      Prompt.makeMessage("assistant", {
        content: [
          Prompt.makePart("text", {
            text: "Scout: fetch has no default timeout.",
          }),
        ],
      }),
      Prompt.makeMessage("user", {
        content: [Prompt.makePart("text", { text: "what about httpx?" })],
      }),
    ];

    const text = toPromptText(messages);
    expect(text).toBe(
      "USER:\ndefault timeout?\n\n" +
        "ASSISTANT:\nScout: fetch has no default timeout.\n\n" +
        "USER:\nwhat about httpx?",
    );
    expect(text).not.toContain("[object Object]");
  });

  it("projects completed agent outcomes to their final response", () => {
    expect(toPromptText({ _tag: "Completed", text: "Use an LRU." })).toBe(
      "Use an LRU.",
    );
  });

  it("uses readable JSON for other structured values", () => {
    const text = toPromptText({ issue: 42, labels: ["bug"] });
    expect(text).toContain('"issue": 42');
    expect(text).not.toBe("[object Object]");
  });
});
