import { cn } from "@/lib/utils";
import { FitAddon, init, Terminal } from "ghostty-web";
import { useEffect, useRef, useState } from "react";

/**
 * Build the terminal-socket URL for a chat id (`${term}:${key}`) —
 * the sibling of `attachUrl` in alchemy/AI/React: same host, same
 * rest-join key encoding, the `/terminal/` path the Worker forwards
 * into the session's Durable Object.
 */
const terminalUrl = (chatId: string): string => {
  const at = chatId.indexOf(":");
  const term = chatId.slice(0, at);
  const key = chatId.slice(at + 1);
  const proto = window.location.protocol.startsWith("https") ? "wss:" : "ws:";
  const keyPath = key
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `${proto}//${window.location.host}/terminal/${encodeURIComponent(term)}/${keyPath}`;
};

/** Wire protocol (mirror of the DO bridge): TEXT frames are JSON
 *  control (`open`/`resize` up, `error` down); BINARY frames are raw
 *  bytes (keystrokes up, PTY output down). */
type ServerFrame = { t: "error"; message: string };

const encoder = new TextEncoder();

/**
 * The TERMINAL tab — a real PTY on the session's machine (the same
 * MicroVM its threads work on), rendered by ghostty. The shell lives
 * in the guest and OUTLIVES this view: closing the tab, dropping the
 * socket, even the Durable Object hibernating — reconnect replays the
 * retained output tail and the shell is exactly where it was.
 */
export const GhosttyTerminal = ({
  sessionId,
  active,
}: {
  /** Chat id of the session's base thread: `Engineer:<session>`. */
  sessionId: string;
  active: boolean;
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const [status, setStatus] = useState<"connecting" | "connected" | "closed">(
    "connecting",
  );

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;

    let disposed = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let reconnectDelay = 1_000;
    let terminal: Terminal | null = null;
    let fit: FitAddon | null = null;

    const connect = () => {
      if (disposed || terminal === null) return;
      setStatus("connecting");
      const ws = new WebSocket(terminalUrl(sessionId));
      ws.binaryType = "arraybuffer";
      socket = ws;

      ws.onopen = () => {
        if (disposed || terminal === null) return;
        setStatus("connected");
        reconnectDelay = 1_000;
        // a reconnect repaints from the guest's retained tail — start
        // from a clean screen so the replay doesn't append to stale
        // output
        terminal.reset();
        ws.send(
          JSON.stringify({ t: "open", cols: terminal.cols, rows: terminal.rows }),
        );
      };

      ws.onmessage = (event) => {
        if (disposed || terminal === null) return;
        if (typeof event.data === "string") {
          const frame = JSON.parse(event.data) as ServerFrame;
          if (frame.t === "error") {
            terminal.writeln(`\r\n\x1b[31m[terminal] ${frame.message}\x1b[0m`);
          }
          return;
        }
        terminal.write(new Uint8Array(event.data as ArrayBuffer));
      };

      ws.onclose = () => {
        if (disposed) return;
        setStatus("closed");
        reconnectTimer = setTimeout(connect, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, 15_000);
      };

      ws.onerror = () => {
        ws.close();
      };
    };

    void init().then(() => {
      if (disposed) return;
      const term = new Terminal({
        fontSize: 12,
        fontFamily:
          'ui-monospace, SFMono-Regular, Menlo, Monaco, "Courier New", monospace',
        cursorBlink: true,
        scrollback: 10_000,
        theme: {
          background: "#0c0c0d",
          foreground: "#d4d4d8",
          cursor: "#d4d4d8",
        },
      });
      terminal = term;
      terminalRef.current = term;
      fit = new FitAddon();
      term.loadAddon(fit);
      term.open(container);
      fit.fit();
      fit.observeResize();

      term.onData((data) => {
        if (socket?.readyState === WebSocket.OPEN) {
          // BINARY = keystrokes (text frames are reserved for control)
          socket.send(encoder.encode(data));
        }
      });
      term.onResize(({ cols, rows }) => {
        if (socket?.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ t: "resize", cols, rows }));
        }
      });

      connect();
    });

    return () => {
      disposed = true;
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
      socket?.close();
      fit?.dispose();
      terminal?.dispose();
      terminalRef.current = null;
    };
  }, [sessionId]);

  useEffect(() => {
    if (active) terminalRef.current?.focus();
  }, [active]);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-[#0c0c0d]">
      <div ref={containerRef} className="min-h-0 flex-1 overflow-hidden" />
      <div className="flex items-center gap-2 border-t border-border px-3 py-1 font-mono text-[10px] text-muted-foreground">
        <span
          className={cn(
            "inline-block h-1.5 w-1.5 rounded-full",
            status === "connected"
              ? "bg-moss"
              : status === "connecting"
                ? "bg-honey animate-pulse"
                : "bg-brick",
          )}
        />
        {status === "connected"
          ? "connected — the session's machine, a real shell"
          : status === "connecting"
            ? "connecting…"
            : "disconnected — reconnecting"}
      </div>
    </div>
  );
};
