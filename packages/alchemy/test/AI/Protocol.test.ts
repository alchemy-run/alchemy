/**
 * Golden wire-format tests for the AI SDK UI Message Stream protocol
 * (src/AI/Api/Protocol.ts). Frames are pinned byte-for-byte against the
 * documented examples (https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol)
 * — drift here breaks OTHER PEOPLE'S UIs, so these are golden, not
 * structural.
 */
import { describe, expect, it } from "@effect/vitest";
import * as S from "effect/Schema";
import {
  ChatRequest,
  messageText,
  SSE_DONE,
  SSE_HEADERS,
  sseFrame,
} from "@/AI/Api/Protocol.ts";

describe("the UI message stream wire format", () => {
  it("frames every chunk kind exactly as documented", () => {
    expect(sseFrame({ type: "start", messageId: "m1" })).toBe(
      'data: {"type":"start","messageId":"m1"}\n\n',
    );
    expect(sseFrame({ type: "start-step" })).toBe(
      'data: {"type":"start-step"}\n\n',
    );
    expect(sseFrame({ type: "text-start", id: "t1" })).toBe(
      'data: {"type":"text-start","id":"t1"}\n\n',
    );
    expect(sseFrame({ type: "text-delta", id: "t1", delta: "Hello" })).toBe(
      'data: {"type":"text-delta","id":"t1","delta":"Hello"}\n\n',
    );
    expect(sseFrame({ type: "text-end", id: "t1" })).toBe(
      'data: {"type":"text-end","id":"t1"}\n\n',
    );
    expect(sseFrame({ type: "reasoning-start", id: "r1" })).toBe(
      'data: {"type":"reasoning-start","id":"r1"}\n\n',
    );
    expect(sseFrame({ type: "reasoning-delta", id: "r1", delta: "hmm" })).toBe(
      'data: {"type":"reasoning-delta","id":"r1","delta":"hmm"}\n\n',
    );
    expect(sseFrame({ type: "reasoning-end", id: "r1" })).toBe(
      'data: {"type":"reasoning-end","id":"r1"}\n\n',
    );
    expect(
      sseFrame({
        type: "tool-input-start",
        toolCallId: "call_1",
        toolName: "getWeather",
      }),
    ).toBe(
      'data: {"type":"tool-input-start","toolCallId":"call_1","toolName":"getWeather"}\n\n',
    );
    expect(
      sseFrame({
        type: "tool-input-available",
        toolCallId: "call_1",
        toolName: "getWeather",
        input: { city: "SF" },
      }),
    ).toBe(
      'data: {"type":"tool-input-available","toolCallId":"call_1","toolName":"getWeather","input":{"city":"SF"}}\n\n',
    );
    expect(
      sseFrame({
        type: "tool-output-available",
        toolCallId: "call_1",
        output: { weather: "sunny" },
      }),
    ).toBe(
      'data: {"type":"tool-output-available","toolCallId":"call_1","output":{"weather":"sunny"}}\n\n',
    );
    expect(
      sseFrame({
        type: "tool-output-error",
        toolCallId: "call_1",
        errorText: "EACCES",
      }),
    ).toBe(
      'data: {"type":"tool-output-error","toolCallId":"call_1","errorText":"EACCES"}\n\n',
    );
    expect(
      sseFrame({
        type: "data-message",
        id: "m-1",
        data: { author: "Scout", text: "use an LRU" },
      }),
    ).toBe(
      'data: {"type":"data-message","id":"m-1","data":{"author":"Scout","text":"use an LRU"}}\n\n',
    );
    expect(
      sseFrame({
        type: "data-ask",
        id: "ask-1",
        data: {
          askId: "ask-1",
          status: "pending",
          payload: { kind: "approval" },
        },
      }),
    ).toBe(
      'data: {"type":"data-ask","id":"ask-1","data":{"askId":"ask-1","status":"pending","payload":{"kind":"approval"}}}\n\n',
    );
    expect(sseFrame({ type: "finish-step" })).toBe(
      'data: {"type":"finish-step"}\n\n',
    );
    expect(sseFrame({ type: "finish" })).toBe('data: {"type":"finish"}\n\n');
    expect(sseFrame({ type: "error", errorText: "boom" })).toBe(
      'data: {"type":"error","errorText":"boom"}\n\n',
    );
    expect(sseFrame({ type: "abort", reason: "user cancelled" })).toBe(
      'data: {"type":"abort","reason":"user cancelled"}\n\n',
    );
    expect(SSE_DONE).toBe("data: [DONE]\n\n");
  });

  it("carries the v1 protocol header", () => {
    expect(SSE_HEADERS["x-vercel-ai-ui-message-stream"]).toBe("v1");
    expect(SSE_HEADERS["content-type"]).toBe("text/event-stream");
  });

  it("decodes a DefaultChatTransport request body leniently", () => {
    // a real useChat body: unknown part types (tool parts from a prior
    // turn) must not reject the request
    const body = {
      id: "conversation-1",
      trigger: "submit-message",
      messages: [
        {
          id: "u1",
          role: "user",
          parts: [{ type: "text", text: "hi there" }],
        },
        {
          id: "a1",
          role: "assistant",
          parts: [
            { type: "step-start" },
            {
              type: "tool-getWeather",
              toolCallId: "c1",
              state: "output-available",
              input: { city: "SF" },
              output: { weather: "sunny" },
            },
            { type: "text", text: "it is sunny" },
          ],
        },
      ],
    };
    const decoded = S.decodeUnknownSync(ChatRequest)(body);
    expect(decoded.id).toBe("conversation-1");
    expect(decoded.messages).toHaveLength(2);
    expect(messageText(decoded.messages[0]!)).toBe("hi there");
    expect(messageText(decoded.messages[1]!)).toBe("it is sunny");
  });
});
