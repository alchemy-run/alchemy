/**
 * Shared types between server and UI.
 *
 * The card model has three tiers of data, each with a different producer:
 *
 * 1. INTENT — authored by the orchestrator LLM once, at spawn time, as
 *    schema-enforced tool args (`title` in conventional-commit form, `brief`).
 * 2. PROTOCOL — verbatim from the worker agent's structured stream
 *    (questions, permission requests, final result summary). Never paraphrased.
 * 3. TELEMETRY — a pure reducer over adapter events plus `git diff --numstat`
 *    (status, activity line, files touched, tool counts, diffstat, cost).
 *
 * Nothing on a card is produced by an extra summarizer model call.
 */

export type TaskStatus =
  | "starting"
  | "running"
  | "needs_input"
  | "done"
  | "failed"
  | "stopped";

export interface TaskQuestionOption {
  label: string;
  description?: string;
}

export interface TaskQuestion {
  id: string;
  /** "question" = the agent asked something; "permission" = a gated tool call */
  kind: "question" | "permission";
  text: string;
  options: TaskQuestionOption[];
  /** whether a free-text answer is accepted in addition to options */
  freeform: boolean;
}

export interface TranscriptEntry {
  /** agent = the worker; dispatch = orchestrator/user messages sent into the thread; tool = tool activity */
  role: "agent" | "dispatch" | "tool";
  text: string;
  at: number;
}

export interface DiffStat {
  additions: number;
  deletions: number;
  files: number;
}

export interface TaskCard {
  id: string;
  /** conventional-commit style, e.g. "fix(r2): bound retry schedule in bucket tests" */
  title: string;
  agent: string;
  cwd: string;
  brief: string;
  status: TaskStatus;
  /** deterministic one-liner derived from the latest adapter event */
  activity: string;
  question: TaskQuestion | null;
  /** the worker's final result text for its last turn, verbatim (truncated) */
  summary: string | null;
  filesTouched: string[];
  toolCounts: Record<string, number>;
  diff: DiffStat | null;
  startedAt: number;
  updatedAt: number;
  endedAt: number | null;
  costUsd: number | null;
  turns: number | null;
  /** rolling tail of the thread, for the inline peek (capped) */
  transcript: TranscriptEntry[];
}

/** Conversation entries mirror AI SDK UIMessage parts: text interleaved with task refs. */
export type ConvPart = { t: "text"; text: string } | { t: "task"; taskId: string };

export interface ConvEntry {
  id: string;
  role: "user" | "orch" | "system";
  parts: ConvPart[];
  at: number;
  done: boolean;
}

export type ServerEvent =
  | { type: "snapshot"; conversation: ConvEntry[]; tasks: TaskCard[] }
  | { type: "conv"; entry: ConvEntry }
  | { type: "conv-remove"; id: string }
  | { type: "task"; card: TaskCard };
