import {
  spawnClaudeCodeTask,
  type SpawnTaskOptions,
  type TaskHandle,
} from "./adapters/claudeCode.ts";
import { store } from "./store.ts";
import type { TaskCard } from "./types.ts";
import { nextId } from "./util.ts";

export type TaskTransition = "needs_input" | "done" | "failed";

type TransitionListener = (card: TaskCard, kind: TaskTransition) => void;

const CONVENTIONAL_COMMIT = /^(feat|fix|chore|refactor|test|docs|perf|build|ci|style)(\([a-z0-9./-]+\))?!?: .+/;

class TaskManager {
  private handles = new Map<string, TaskHandle>();
  private transitionListeners = new Set<TransitionListener>();

  onTransition(listener: TransitionListener): void {
    this.transitionListeners.add(listener);
  }

  isValidTitle(title: string): boolean {
    return CONVENTIONAL_COMMIT.test(title);
  }

  create(args: { title: string; brief: string; cwd: string; autonomy: "safe" | "full" }): TaskCard {
    const id = nextId("task");
    const card: TaskCard = {
      id,
      title: args.title,
      agent: "claude-code",
      cwd: args.cwd,
      brief: args.brief,
      status: "starting",
      activity: "Starting session",
      question: null,
      summary: null,
      filesTouched: [],
      toolCounts: {},
      diff: null,
      startedAt: Date.now(),
      updatedAt: Date.now(),
      endedAt: null,
      costUsd: null,
      turns: null,
      transcript: [],
    };
    store.upsertTask(card);

    const opts: SpawnTaskOptions = {
      brief: args.brief,
      cwd: args.cwd,
      autonomy: args.autonomy,
    };
    const handle = spawnClaudeCodeTask(opts, {
      card,
      update: (mutate) => {
        mutate(card);
        store.upsertTask(card);
      },
      transition: (kind) => {
        for (const listener of this.transitionListeners) listener(card, kind);
      },
    });
    this.handles.set(id, handle);
    return card;
  }

  get(id: string): TaskCard | undefined {
    return store.tasks.get(id);
  }

  list(): TaskCard[] {
    return [...store.tasks.values()];
  }

  message(id: string, text: string, from: "user" | "dispatch"): boolean {
    const handle = this.handles.get(id);
    if (!handle) return false;
    handle.send(text, from);
    return true;
  }

  answer(id: string, questionId: string, value: string): boolean {
    const handle = this.handles.get(id);
    if (!handle) return false;
    return handle.answer(questionId, value);
  }

  async stop(id: string): Promise<boolean> {
    const handle = this.handles.get(id);
    if (!handle) return false;
    await handle.stop();
    return true;
  }
}

export const taskManager = new TaskManager();
