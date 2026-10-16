/**
 * The few message/part shapes AI Elements components are typed against —
 * defined locally so the components render our own transcript
 * (`alchemy/AI/Client`'s `reduceTranscript`) without the AI SDK.
 */

export type ToolState =
  | "input-streaming"
  | "input-available"
  | "approval-requested"
  | "approval-responded"
  | "output-available"
  | "output-error"
  | "output-denied";

export interface ToolUIPart {
  type: `tool-${string}` | "dynamic-tool";
  state: ToolState;
  input?: unknown;
  output?: unknown;
  errorText?: string;
  approval?: { id: string; approved?: boolean; reason?: string };
}

export interface UIMessage {
  role: "user" | "assistant" | "system";
}

export interface FileUIPart {
  type: "file";
  mediaType: string;
  url: string;
  filename?: string;
}

export type ChatStatus = "submitted" | "streaming" | "ready" | "error";
