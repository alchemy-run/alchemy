/**
 * The client side of the CURSOR PROTOCOL (`src/platform/Cursor.ts`):
 * page `GET /api/channel` to the head, then ride the `/channel`
 * WebSocket — `subscribe { after }`, replay batches, a `live` marker,
 * then `item` per append and `update` for in-place amendments. The
 * client asserts density (`item.seq === last + 1`); on a gap or a
 * reconnect it re-subscribes from its own `after`, so push is a
 * latency optimization and never a correctness dependency.
 */

import { useEffect, useRef, useState } from "react";
import type { ChannelMessage, ThreadDirectoryRow } from "./channel";

type ServerFrame =
  | { type: "batch"; items: ChannelMessage[]; head: number }
  | { type: "live"; seq: number }
  | { type: "item"; item: ChannelMessage }
  | { type: "update"; item: ChannelMessage }
  | { type: "directory"; rows: ThreadDirectoryRow[] };

export interface ChannelStream {
  /** The log so far, oldest first (dense seq). */
  readonly messages: ReadonlyArray<ChannelMessage>;
  /** The thread directory, as the socket last pushed it. */
  readonly directory: ReadonlyArray<ThreadDirectoryRow>;
  /** Live = subscribed and caught up. */
  readonly live: boolean;
}

const wsUrl = (): string => {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/channel`;
};

/** The channel, streamed: one hook instance per app. */
export const useChannelStream = (): ChannelStream => {
  const [messages, setMessages] = useState<ReadonlyArray<ChannelMessage>>([]);
  const [directory, setDirectory] = useState<
    ReadonlyArray<ThreadDirectoryRow>
  >([]);
  const [live, setLive] = useState(false);

  useEffect(() => {
    // the log, keyed by seq — the array the UI renders is derived
    const bySeq = new Map<number, ChannelMessage>();
    let after = 0;
    let socket: WebSocket | undefined;
    let retry = 0;
    let closed = false;
    let timer = 0;

    const paint = () => {
      const items = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
      setMessages(items);
    };

    const absorb = (items: ReadonlyArray<ChannelMessage>) => {
      for (const item of items) {
        bySeq.set(item.seq, item);
        if (item.seq > after) after = item.seq;
      }
      if (items.length > 0) paint();
    };

    const subscribe = () => {
      socket?.send(JSON.stringify({ type: "subscribe", after }));
    };

    const connect = () => {
      if (closed) return;
      const ws = new WebSocket(wsUrl());
      socket = ws;
      ws.onopen = () => {
        retry = 0;
        subscribe();
      };
      ws.onmessage = (event) => {
        let frame: ServerFrame;
        try {
          frame = JSON.parse(String(event.data)) as ServerFrame;
        } catch {
          return;
        }
        switch (frame.type) {
          case "batch":
            absorb(frame.items);
            break;
          case "live":
            setLive(true);
            break;
          case "item":
            if (frame.item.seq > after + 1) {
              // a GAP — dense seq makes it detectable; re-subscribe
              // from our own watermark rather than guessing
              subscribe();
              break;
            }
            absorb([frame.item]);
            break;
          case "update":
            // an amendment re-delivered under its ORIGINAL seq — only
            // rows we already hold update in place (replay covers the
            // rest)
            if (bySeq.has(frame.item.seq)) {
              bySeq.set(frame.item.seq, frame.item);
              paint();
            }
            break;
          case "directory":
            setDirectory(frame.rows);
            break;
        }
      };
      ws.onclose = () => {
        if (closed) return;
        setLive(false);
        const backoff = Math.min(500 * 2 ** retry, 15_000);
        retry += 1;
        timer = window.setTimeout(connect, backoff);
      };
    };

    // FIRST PAINT over GET (it also kicks the server's one-time
    // bootstrap on an empty channel), then the socket owns the tail.
    let cancelled = false;
    const prime = async () => {
      try {
        let cursor = 0;
        for (;;) {
          const response = await fetch(
            `/api/channel?after=${cursor}&limit=200`,
          );
          if (!response.ok || cancelled) break;
          const page = (await response.json()) as {
            items: ChannelMessage[];
            head: number;
            next: number | null;
          };
          absorb(page.items);
          if (page.next === null) break;
          cursor = page.next;
        }
      } catch {
        // the socket replay covers a failed page
      }
      if (!cancelled) connect();
    };
    void prime();

    return () => {
      closed = true;
      cancelled = true;
      window.clearTimeout(timer);
      socket?.close();
    };
  }, []);

  return { messages, directory, live };
};

/** A thread's state snapshot, pushed whole over `/thread/:id`. */
export const useThreadState = <T,>(id: string | undefined): T | undefined => {
  const [state, setState] = useState<T | undefined>(undefined);
  const idRef = useRef(id);
  idRef.current = id;

  useEffect(() => {
    setState(undefined);
    if (id === undefined) return;
    let closed = false;
    let retry = 0;
    let timer = 0;
    let socket: WebSocket | undefined;

    // first paint over GET; the socket pushes every change after
    fetch(`/api/threads/${encodeURIComponent(id)}`)
      .then((response) => (response.ok ? response.json() : undefined))
      .then((value) => {
        if (!closed && value !== undefined) setState(value as T);
      })
      .catch(() => {});

    const connect = () => {
      if (closed) return;
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(
        `${proto}//${window.location.host}/thread/${encodeURIComponent(id)}`,
      );
      socket = ws;
      ws.onopen = () => {
        retry = 0;
      };
      ws.onmessage = (event) => {
        try {
          const frame = JSON.parse(String(event.data)) as {
            type: string;
            state?: T;
          };
          if (frame.type === "state" && frame.state !== undefined) {
            setState(frame.state);
          }
        } catch {
          // tolerate junk frames
        }
      };
      ws.onclose = () => {
        if (closed) return;
        const backoff = Math.min(500 * 2 ** retry, 15_000);
        retry += 1;
        timer = window.setTimeout(connect, backoff);
      };
    };
    connect();

    return () => {
      closed = true;
      window.clearTimeout(timer);
      socket?.close();
    };
  }, [id]);

  return state;
};
