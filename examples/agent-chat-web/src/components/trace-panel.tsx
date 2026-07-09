/**
 * The engine room (designs/ai/chat-apps.md §2.2): a read-only,
 * seq-cursored feed of kernel facts over `GET /v1/stream/:ring` —
 * every durable Trace row the chat view is a projection of, plus the
 * live deltas. Same log, different zoom level.
 *
 * The feed is a native `EventSource`: the endpoint frames each event
 * with its `seq` as the SSE id, so the browser's automatic reconnect
 * carries the cursor and the client just dedupes by seq.
 */
import { Badge } from "@/components/ui/badge";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import { useEffect, useRef, useState } from "react";

export interface TraceEvent {
  type: string;
  id: string;
  seq?: number;
  session?: string;
  durable: boolean;
  payload?: Record<string, unknown>;
}

const badgeTone: Record<string, string> = {
  "run.admitted": "bg-blue-500/15 text-blue-500",
  "model.requested": "bg-violet-500/15 text-violet-400",
  "model.completed": "bg-violet-500/15 text-violet-400",
  "tool.requested": "bg-emerald-500/15 text-emerald-500",
  "tool.completed": "bg-emerald-500/15 text-emerald-500",
  "tool.failed": "bg-red-500/15 text-red-500",
  "ask.requested": "bg-amber-500/15 text-amber-500",
  "ask.answered": "bg-amber-500/15 text-amber-500",
  "turn.halted": "bg-zinc-500/15 text-muted-foreground",
};

/** One-line, human-scannable summary of a row's payload. */
const summarize = (event: TraceEvent): string => {
  const payload = event.payload ?? {};
  switch (event.type) {
    case "run.admitted":
      return JSON.stringify(payload.item);
    case "model.completed": {
      const usage = payload.usage as
        | { inputTokens?: { total?: number }; outputTokens?: { total?: number } }
        | undefined;
      return `${String(payload.finishReason)} · ${usage?.inputTokens?.total ?? "?"} in / ${usage?.outputTokens?.total ?? "?"} out`;
    }
    case "tool.requested":
      return `${String(payload.name)}(${JSON.stringify(payload.params)})`;
    case "tool.completed":
    case "tool.failed":
      return `${String(payload.name)} → ${JSON.stringify(payload.result)}`;
    case "ask.requested":
      return JSON.stringify(
        (payload.payload as { text?: string } | undefined)?.text,
      );
    case "ask.answered":
      return String(payload.verdict);
    case "turn.halted":
      return String(payload.outcome);
    case "model.delta":
      return String(payload.delta ?? "");
    default:
      return "";
  }
};

/** How many rows the LIVE tail keeps; scroll-back pages beyond it. */
const WINDOW = 500;
/** Rows fetched per "load earlier" page. */
const PAGE = 200;

export function TracePanel({ ring }: { ring: string }) {
  const [events, setEvents] = useState<TraceEvent[]>([]);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const lastSeq = useRef(0);
  // paging back is reader intent: once they reach for history, the
  // sliding window stops evicting (rule 3 — every interaction is intent)
  const pagedBack = useRef(false);

  useEffect(() => {
    const source = new EventSource(
      `/v1/stream/${encodeURIComponent(ring)}?offset=0`,
    );
    source.onmessage = (message) => {
      const event = JSON.parse(message.data) as TraceEvent;
      // reconnects replay — the seq cursor dedupes
      if (event.seq !== undefined && event.seq <= lastSeq.current) return;
      if (event.seq !== undefined) lastSeq.current = event.seq;
      setEvents((current) =>
        pagedBack.current
          ? [...current, event]
          : [...current.slice(-(WINDOW - 1)), event],
      );
    };
    return () => source.close();
  }, [ring]);

  const firstSeq = events.find((event) => event.seq !== undefined)?.seq ?? 1;
  const hasEarlier = firstSeq > 1;

  /**
   * Page older rows back in: a bounded `&limit=` fetch (the response
   * completes — no tail), prepended with the viewport preserving the
   * reader's place (`preserveScrollOnPrepend`, scroll rule 12).
   */
  const loadEarlier = async () => {
    setLoadingEarlier(true);
    pagedBack.current = true;
    try {
      const offset = Math.max(0, firstSeq - 1 - PAGE);
      const limit = firstSeq - 1 - offset;
      const body = await (
        await fetch(
          `/v1/stream/${encodeURIComponent(ring)}?offset=${offset}&limit=${limit}`,
        )
      ).text();
      const earlier = body
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => JSON.parse(line.slice("data: ".length)) as TraceEvent)
        .filter((event) => event.seq !== undefined && event.seq < firstSeq);
      setEvents((current) => [...earlier, ...current]);
    } finally {
      setLoadingEarlier(false);
    }
  };

  return (
    <aside className="flex w-96 min-h-0 flex-col border-l">
      <div className="flex items-baseline justify-between border-b px-3 py-2">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          trace · {ring}
        </span>
        <span className="text-xs text-muted-foreground">
          seq {lastSeq.current || "—"}
        </span>
      </div>
      {events.length === 0 ? (
        <p className="p-4 text-xs text-muted-foreground">
          No kernel facts yet — send a message.
        </p>
      ) : (
        <MessageScrollerProvider autoScroll>
          <MessageScroller className="flex-1">
            <MessageScrollerViewport preserveScrollOnPrepend>
              <MessageScrollerContent className="gap-0 px-2 py-2">
                {hasEarlier && (
                  <MessageScrollerItem messageId="load-earlier">
                    <button
                      type="button"
                      disabled={loadingEarlier}
                      onClick={() => void loadEarlier()}
                      className="w-full rounded px-1 py-1 text-center text-[11px] text-muted-foreground hover:bg-accent disabled:opacity-50"
                    >
                      {loadingEarlier
                        ? "loading…"
                        : `load earlier (${firstSeq - 1} rows above)`}
                    </button>
                  </MessageScrollerItem>
                )}
                {events.map((event) => (
                  <MessageScrollerItem key={event.id} messageId={event.id}>
                    <div className="flex items-start gap-2 rounded px-1 py-1 font-mono text-[11px] leading-4">
                      <span className="w-7 shrink-0 text-right text-muted-foreground/60">
                        {event.seq ?? "·"}
                      </span>
                      <Badge
                        variant="secondary"
                        className={`shrink-0 rounded px-1 py-0 text-[10px] font-medium ${badgeTone[event.type] ?? ""}`}
                      >
                        {event.type}
                      </Badge>
                      <span className="min-w-0 break-all text-muted-foreground">
                        {summarize(event)}
                      </span>
                    </div>
                  </MessageScrollerItem>
                ))}
              </MessageScrollerContent>
            </MessageScrollerViewport>
            <MessageScrollerButton />
          </MessageScroller>
        </MessageScrollerProvider>
      )}
    </aside>
  );
}
