import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { FitAddon, init, Terminal } from "ghostty-web";
import { useEffect, useRef, useState } from "react";

/**
 * Build the terminal-socket URL for a chat id (`${term}:${key}`) —
 * the sibling of `attachUrl` in alchemy/AI/React: same host, same
 * rest-join key encoding, the `/terminal/` path the Worker forwards
 * into the session's Durable Object. `ptyId` names WHICH shell on the
 * session's machine — every terminal tab is its own PTY.
 */
const terminalUrl = (chatId: string, ptyId: string): string => {
  const at = chatId.indexOf(":");
  const term = chatId.slice(0, at);
  const key = chatId.slice(at + 1);
  const proto = window.location.protocol.startsWith("https") ? "wss:" : "ws:";
  const keyPath = key
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `${proto}//${window.location.host}/terminal/${encodeURIComponent(term)}/${keyPath}?id=${encodeURIComponent(ptyId)}`;
};

/** Wire protocol (mirror of the DO bridge): TEXT frames are JSON
 *  control (`open`/`resize` up, `error`/`status` down); BINARY frames
 *  are raw bytes (keystrokes up, PTY output down). */
type ServerFrame =
  | { t: "error"; message: string }
  | { t: "status"; message: string };

/**
 * The connection's PHASE, not just the socket's: "connected" to the
 * Durable Object says nothing about the MACHINE behind it — a cold
 * MicroVM launches (or a suspended one resumes) during `pty.open`, and
 * that can take from seconds to a minute. Only the PTY's first output
 * byte proves the machine is live.
 */
type Phase = "connecting" | "starting" | "live" | "closed";

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
  ptyId,
  active,
  registerKill,
}: {
  /** Chat id of the session's base thread: `Engineer:<session>`. */
  sessionId: string;
  /** The PTY id on the session's machine — one per terminal tab. */
  ptyId: string;
  active: boolean;
  /**
   * Receives the KILL action: sends the close frame (the guest shell
   * dies) and stops reconnecting. The parent's tab × calls it right
   * before unmounting this view.
   */
  registerKill?: (kill: () => void) => void;
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  // latest registration callback without re-running the socket effect
  const registerKillRef = useRef(registerKill);
  registerKillRef.current = registerKill;
  // read at async-init time: a freshly created tab is active before the
  // terminal object exists, so the [active] effect alone can't focus it
  const activeRef = useRef(active);
  activeRef.current = active;
  const [phase, setPhase] = useState<Phase>("connecting");
  const [statusMessage, setStatusMessage] = useState(
    "starting the session's machine",
  );
  // a boot that outlives this flips the overlay to the cold-start note
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;

    let disposed = false;
    let killed = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let reconnectDelay = 1_000;
    let terminal: Terminal | null = null;
    let fit: FitAddon | null = null;
    let removeMouseBridge: (() => void) | undefined;
    let slowTimer: ReturnType<typeof setTimeout> | undefined;

    // the tab's ×: kill the guest shell and stop reconnecting — the
    // parent removes the tab (and this view) right after
    registerKillRef.current?.(() => {
      killed = true;
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ t: "close" }));
      }
    });

    const clearSlow = () => {
      if (slowTimer !== undefined) clearTimeout(slowTimer);
      slowTimer = undefined;
      setSlow(false);
    };
    /** Enter a waiting phase: the overlay shows `message`, and after
     *  12s of no output escalates to the cold-start explanation. */
    const waiting = (message: string) => {
      setPhase("starting");
      setStatusMessage(message);
      clearSlow();
      slowTimer = setTimeout(() => setSlow(true), 12_000);
    };

    const connect = () => {
      if (disposed || killed || terminal === null) return;
      setPhase("connecting");
      const ws = new WebSocket(terminalUrl(sessionId, ptyId));
      ws.binaryType = "arraybuffer";
      socket = ws;

      ws.onopen = () => {
        if (disposed || terminal === null) return;
        // the SOCKET is up, but the machine behind it may still be
        // launching — "live" waits for the PTY's first byte
        waiting("starting the session's machine");
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
          if (frame.t === "status") {
            // the DO narrates the slow paths (launching, waking from
            // suspend) — show them until output proves the machine live
            waiting(frame.message);
          } else if (frame.t === "error") {
            terminal.writeln(`\r\n\x1b[31m[terminal] ${frame.message}\x1b[0m`);
            // clear the overlay so the error is readable
            setPhase("live");
            clearSlow();
          }
          return;
        }
        // output = the machine is ALIVE
        setPhase("live");
        clearSlow();
        terminal.write(new Uint8Array(event.data as ArrayBuffer));
      };

      ws.onclose = () => {
        if (disposed || killed) return;
        setPhase("closed");
        clearSlow();
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
      // a new tab mounts active — take focus as soon as the terminal
      // exists (menus that spawned the tab must not keep it; see the
      // onCloseAutoFocus preventDefault on their Content)
      if (activeRef.current) term.focus();

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

      // ── MOUSE → the application (xterm mouse reporting) ──
      // ghostty-web has NO mouse reporting: its canvas handlers only do
      // local selection/clipboard, so a TUI that enables mouse tracking
      // (herdr) never hears about the mouse at all. The wasm VT core
      // DOES track the app's DECSET state, so bridge like a real
      // terminal: while tracking is ON, forward EVERY button's
      // press/release, wheel ticks, and (per mode 1002/1003) motion —
      // half a bridge is worse than none: a right-click menu the app
      // opens can only be operated or dismissed by further mouse
      // events, so forwarding just one button wedges the app. SHIFT
      // bypasses reporting (the xterm convention) — shift-drag selects
      // locally, shift-right-click gets the browser menu. Tracking
      // off — a plain shell — nothing here runs.
      const tracking = (): boolean =>
        term.wasmTerm?.hasMouseTracking() === true;
      const cellOf = (event: { clientX: number; clientY: number }) => {
        const renderer = term.renderer;
        if (renderer === undefined) return undefined;
        const rect = renderer.getCanvas().getBoundingClientRect();
        return {
          col: Math.min(
            term.cols,
            Math.max(
              1,
              Math.floor((event.clientX - rect.left) / renderer.charWidth) + 1,
            ),
          ),
          row: Math.min(
            term.rows,
            Math.max(
              1,
              Math.floor((event.clientY - rect.top) / renderer.charHeight) + 1,
            ),
          ),
        };
      };
      /** SGR (mode 1006) when the app enabled it, legacy X10 otherwise. */
      const sendMouse = (
        code: number,
        event: { clientX: number; clientY: number },
        release: boolean,
      ): boolean => {
        const wasm = term.wasmTerm;
        const cell = cellOf(event);
        if (wasm === undefined || cell === undefined) return false;
        if (socket?.readyState !== WebSocket.OPEN) return false;
        if (wasm.getMode(1006)) {
          socket.send(
            encoder.encode(
              `\x1b[<${code};${cell.col};${cell.row}${release ? "m" : "M"}`,
            ),
          );
        } else {
          socket.send(
            new Uint8Array([
              0x1b,
              0x5b,
              0x4d,
              32 + (release ? 3 : code),
              Math.min(255, 32 + cell.col),
              Math.min(255, 32 + cell.row),
            ]),
          );
        }
        return true;
      };
      /** The held button's code (drag motion reports it); -1 = none. */
      let pressed = -1;
      let lastMotionCell = "";
      const onMouseDown = (event: MouseEvent) => {
        if (event.shiftKey || !tracking()) return;
        if (event.button > 2) return;
        if (sendMouse(event.button, event, false)) {
          pressed = event.button;
          lastMotionCell = "";
          event.preventDefault();
          // ghostty must not start a LOCAL selection while the app owns
          // the mouse (shift-drag remains the local path)
          event.stopPropagation();
          container.focus();
        }
      };
      const onMouseUp = (event: MouseEvent) => {
        if (event.shiftKey || !tracking()) return;
        if (event.button > 2) return;
        if (sendMouse(event.button, event, true)) {
          pressed = -1;
          event.preventDefault();
          event.stopPropagation();
        }
      };
      const onMouseMove = (event: MouseEvent) => {
        if (event.shiftKey || !tracking()) return;
        const wasm = term.wasmTerm;
        if (wasm === undefined) return;
        // 1003 = every motion; 1002 = only while a button is held
        const anyMotion = wasm.getMode(1003);
        if (!anyMotion && !(wasm.getMode(1002) && pressed >= 0)) return;
        const cell = cellOf(event);
        if (cell === undefined) return;
        const at = `${cell.col}:${cell.row}`;
        if (at === lastMotionCell) return; // one report per cell
        lastMotionCell = at;
        // motion = button code + 32 (3 = no button, for any-motion)
        sendMouse((pressed >= 0 ? pressed : 3) + 32, event, false);
      };
      const onWheel = (event: WheelEvent) => {
        if (event.shiftKey || !tracking()) return;
        if (event.deltaY === 0) return;
        if (sendMouse(event.deltaY < 0 ? 64 : 65, event, false)) {
          // the app owns scrolling — not the local scrollback viewport
          event.preventDefault();
          event.stopPropagation();
        }
      };
      const onContextMenu = (event: MouseEvent) => {
        if (event.shiftKey || !tracking()) return;
        event.preventDefault();
        // also skips ghostty's clipboard staging — the click belongs
        // to the application while tracking is on
        event.stopPropagation();
      };
      // capture phase: ancestors run first, so these beat ghostty's own
      // canvas handlers (its wheel listener is capture on the canvas)
      container.addEventListener("mousedown", onMouseDown, true);
      container.addEventListener("mouseup", onMouseUp, true);
      container.addEventListener("mousemove", onMouseMove, true);
      container.addEventListener("wheel", onWheel, {
        capture: true,
        passive: false,
      });
      container.addEventListener("contextmenu", onContextMenu, true);
      removeMouseBridge = () => {
        container.removeEventListener("mousedown", onMouseDown, true);
        container.removeEventListener("mouseup", onMouseUp, true);
        container.removeEventListener("mousemove", onMouseMove, true);
        container.removeEventListener("wheel", onWheel, true);
        container.removeEventListener("contextmenu", onContextMenu, true);
      };

      connect();
    });

    return () => {
      disposed = true;
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
      if (slowTimer !== undefined) clearTimeout(slowTimer);
      removeMouseBridge?.();
      socket?.close();
      fit?.dispose();
      terminal?.dispose();
      terminalRef.current = null;
    };
  }, [sessionId, ptyId]);

  useEffect(() => {
    if (active) terminalRef.current?.focus();
  }, [active]);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-[#0c0c0d]">
      <div className="relative min-h-0 flex-1">
        <div
          ref={containerRef}
          className="ghostty-host absolute inset-0 overflow-hidden"
        />
        {(phase === "connecting" || phase === "starting") && (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 bg-[#0c0c0d]/80">
            <Spinner className="size-4 text-[#d4d4d8]" />
            <span className="font-mono text-xs text-[#d4d4d8]">
              {phase === "connecting" ? "connecting" : statusMessage}…
            </span>
            {slow && (
              <span className="max-w-72 text-center font-mono text-[10px] text-[#8a8a93]">
                a cold machine boots its image first — this can take a
                minute
              </span>
            )}
          </div>
        )}
      </div>
      <div className="flex items-center gap-2 border-t border-border px-3 py-1 font-mono text-[10px] text-muted-foreground">
        <span
          className={cn(
            "inline-block h-1.5 w-1.5 rounded-full",
            phase === "live"
              ? "bg-moss"
              : phase === "closed"
                ? "bg-brick"
                : "bg-honey animate-pulse",
          )}
        />
        {phase === "live"
          ? "connected — the session's machine, a real shell"
          : phase === "starting"
            ? `${statusMessage}…`
            : phase === "connecting"
              ? "connecting…"
              : "disconnected — reconnecting"}
      </div>
    </div>
  );
};
