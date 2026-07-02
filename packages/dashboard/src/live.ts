import { useEffect, useRef, useState } from "react";
import type { DashboardPlan } from "./types.ts";

/** Mirrors packages/alchemy/src/Cli/Event.ts */
export interface ApplyEventJson {
  kind: "status-change" | "annotate" | "log";
  id: string;
  type?: string;
  status?: string;
  level?: string;
  message?: string;
  bindingId?: string;
}

interface ApplySessionJson {
  sessionId: string;
  plan: DashboardPlan;
  events: { seq: number; event: ApplyEventJson }[];
  done: boolean;
  startedAt: string;
}

type ServerMessage =
  | { kind: "snapshot"; session: ApplySessionJson | null }
  | { kind: "apply-start"; session: ApplySessionJson }
  | { kind: "apply-event"; seq: number; event: ApplyEventJson }
  | { kind: "apply-done" };

export interface FeedEntry {
  key: number;
  id: string;
  text: string;
  status?: string;
  /** log-level entries render dimmed */
  log?: boolean;
}

export interface ResourceLogEntry {
  key: number;
  level: string;
  message: string;
}

/** keep the last N log lines per resource */
const LOG_CAP = 500;

export interface LiveApply {
  sessionId: string;
  plan: DashboardPlan;
  /** latest status per resource logical id (bindings roll up to the host) */
  statuses: Map<string, { status: string; message?: string }>;
  /** latest annotate note per resource logical id */
  notes: Map<string, string>;
  /** captured Effect.log* lines per resource logical id */
  logs: Map<string, ResourceLogEntry[]>;
  feed: FeedEntry[];
  done: boolean;
}

const applyEvent = (live: LiveApply, seq: number, event: ApplyEventJson) => {
  switch (event.kind) {
    case "status-change": {
      if (!event.status) {
        return;
      }
      if (!event.bindingId) {
        live.statuses.set(event.id, {
          status: event.status,
          message: event.message,
        });
      }
      live.feed.push({
        key: seq,
        id: event.bindingId ? `${event.id}/${event.bindingId}` : event.id,
        text: event.message
          ? `${event.status} — ${event.message}`
          : event.status,
        status: event.status,
      });
      return;
    }
    case "annotate": {
      live.notes.set(event.id, event.message ?? "");
      live.feed.push({ key: seq, id: event.id, text: event.message ?? "" });
      return;
    }
    case "log": {
      const entries = live.logs.get(event.id) ?? [];
      entries.push({
        key: seq,
        level: event.level ?? "Info",
        message: event.message ?? "",
      });
      if (entries.length > LOG_CAP) {
        entries.splice(0, entries.length - LOG_CAP);
      }
      live.logs.set(event.id, entries);
      live.feed.push({
        key: seq,
        id: event.id,
        text: event.message ?? "",
        log: true,
      });
      return;
    }
  }
};

const fromSession = (session: ApplySessionJson): LiveApply => {
  const live: LiveApply = {
    sessionId: session.sessionId,
    plan: session.plan,
    statuses: new Map(),
    notes: new Map(),
    logs: new Map(),
    feed: [],
    done: session.done,
  };
  for (const { seq, event } of session.events) {
    applyEvent(live, seq, event);
  }
  return live;
};

/**
 * Subscribe to the dashboard's SSE apply stream. Returns the current live
 * apply session (with replay for browsers connecting mid-deploy) and calls
 * `onDone` when the apply completes so the caller can refetch state/plan.
 */
export function useApplyStream(onDone: () => void): LiveApply | undefined {
  const [live, setLive] = useState<LiveApply>();
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useEffect(() => {
    const source = new EventSource("/api/events");
    let current: LiveApply | undefined;

    source.onmessage = (message) => {
      const msg = JSON.parse(message.data) as ServerMessage;
      switch (msg.kind) {
        case "snapshot":
          current = msg.session ? fromSession(msg.session) : undefined;
          break;
        case "apply-start":
          current = fromSession(msg.session);
          break;
        case "apply-event":
          if (current) {
            applyEvent(current, msg.seq, msg.event);
          }
          break;
        case "apply-done":
          if (current) {
            current.done = true;
            onDoneRef.current();
          }
          break;
      }
      setLive(
        current
          ? {
              ...current,
              statuses: new Map(current.statuses),
              notes: new Map(current.notes),
              logs: new Map(current.logs),
              feed: [...current.feed],
            }
          : undefined,
      );
    };

    return () => source.close();
  }, []);

  return live;
}
