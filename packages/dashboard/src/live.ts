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

export interface PendingApproval {
  id: string;
  plan: DashboardPlan;
}

type ServerMessage =
  | {
      kind: "snapshot";
      session: ApplySessionJson | null;
      approval: PendingApproval | null;
    }
  | { kind: "apply-start"; session: ApplySessionJson }
  | { kind: "apply-event"; seq: number; event: ApplyEventJson }
  | { kind: "apply-done" }
  | { kind: "approval-request"; approval: PendingApproval }
  | { kind: "approval-done"; id: string; approved: boolean };

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

export type ApplyResult =
  | "created"
  | "updated"
  | "replaced"
  | "deleted"
  | "failed";

export interface LiveApply {
  sessionId: string;
  plan: DashboardPlan;
  /** latest status per resource logical id (bindings roll up to the host) */
  statuses: Map<string, { status: string; message?: string }>;
  /** latest annotate note per resource logical id */
  notes: Map<string, string>;
  /** captured Effect.log* lines per resource logical id */
  logs: Map<string, ResourceLogEntry[]>;
  /**
   * terminal outcome per resource logical id — what this apply DID.
   * `type` is kept so deleted resources (gone from state) can still be
   * rendered as ghost nodes.
   */
  results: Map<string, { result: ApplyResult; type: string }>;
  feed: FeedEntry[];
  done: boolean;
}

const TERMINAL: Record<string, ApplyResult> = {
  created: "created",
  updated: "updated",
  replaced: "replaced",
  deleted: "deleted",
  fail: "failed",
};

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
        const result = TERMINAL[event.status];
        if (result) {
          live.results.set(event.id, {
            result,
            type: event.type ?? "unknown",
          });
        }
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
    results: new Map(),
    feed: [],
    done: session.done,
  };
  for (const { seq, event } of session.events) {
    applyEvent(live, seq, event);
  }
  return live;
};

export interface ApplyStream {
  live: LiveApply | undefined;
  /** a plan waiting for browser-side approval (`deploy --ui` sans --yes) */
  approval: PendingApproval | undefined;
  decide: (id: string, approved: boolean) => void;
}

/**
 * Subscribe to the dashboard's SSE apply stream. Returns the current live
 * apply session (with replay for browsers connecting mid-deploy), any plan
 * pending browser approval, and calls `onDone` when an apply completes so
 * the caller can refetch state/plan.
 */
export function useApplyStream(onDone: () => void): ApplyStream {
  const [live, setLive] = useState<LiveApply>();
  const [approval, setApproval] = useState<PendingApproval>();
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
          setApproval(msg.approval ?? undefined);
          break;
        case "apply-start":
          current = fromSession(msg.session);
          // a starting apply supersedes any approval banner
          setApproval(undefined);
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
        case "approval-request":
          setApproval(msg.approval);
          break;
        case "approval-done":
          setApproval(undefined);
          break;
      }
      setLive(
        current
          ? {
              ...current,
              statuses: new Map(current.statuses),
              notes: new Map(current.notes),
              logs: new Map(current.logs),
              results: new Map(current.results),
              feed: [...current.feed],
            }
          : undefined,
      );
    };

    return () => source.close();
  }, []);

  const decide = (id: string, approved: boolean) => {
    void fetch("/api/approval/decide", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, approved }),
    }).catch(() => undefined);
  };

  return { live, approval, decide };
}
