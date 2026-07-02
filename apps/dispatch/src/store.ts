import type { ConvEntry, ServerEvent, TaskCard } from "./types.ts";

type Listener = (event: ServerEvent) => void;

class Store {
  conversation: ConvEntry[] = [];
  tasks = new Map<string, TaskCard>();
  private listeners = new Set<Listener>();

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: ServerEvent) {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // a dead SSE sink must never take the store down
      }
    }
  }

  snapshot(): ServerEvent {
    return {
      type: "snapshot",
      conversation: this.conversation,
      tasks: [...this.tasks.values()],
    };
  }

  upsertEntry(entry: ConvEntry) {
    const index = this.conversation.findIndex((e) => e.id === entry.id);
    if (index === -1) this.conversation.push(entry);
    else this.conversation[index] = entry;
    this.emit({ type: "conv", entry });
  }

  removeEntry(id: string) {
    this.conversation = this.conversation.filter((e) => e.id !== id);
    this.emit({ type: "conv-remove", id });
  }

  upsertTask(card: TaskCard) {
    card.updatedAt = Date.now();
    this.tasks.set(card.id, card);
    this.emit({ type: "task", card });
  }
}

export const store = new Store();
