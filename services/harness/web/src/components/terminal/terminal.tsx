import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef } from "react";
import { terminal } from "../../agents.ts";
import { PredictiveEcho } from "./predict.ts";

const THEME = {
  background: "#0a0a0a",
  foreground: "#e5e5e5",
  cursor: "#e5e5e5",
  selectionBackground: "#ffffff30",
};

/**
 * A shell in the session's container. Typing is echoed locally at once
 * (see `PredictiveEcho`) and reconciled with the shell's own echo.
 */
export function SessionTerminal({ sessionId }: { sessionId: string }) {
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const term = new Terminal({
      theme: THEME,
      fontFamily: 'ui-monospace, "SF Mono", Menlo, Monaco, monospace',
      fontSize: 12,
      cursorBlink: true,
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(element);
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch {
      // No WebGL: the default renderer works.
    }
    fit.fit();
    // The WebGL renderer draws to a canvas: expose the terminal so tests can
    // read its buffer.
    Object.assign(element, { xterm: term });

    const echo = new PredictiveEcho(term);
    let stop: (() => void) | undefined;
    let ended = false;
    const connect = () => {
      ended = false;
      stop = terminal.open(
        sessionId,
        { cols: term.cols, rows: term.rows },
        (chunk) => term.write(echo.output(chunk)),
        (reason) => {
          ended = true;
          term.write(
            `\r\n\x1b[2m[${reason === "exited" ? "shell exited" : reason} — press any key to start a new one]\x1b[22m\r\n`,
          );
        },
      );
    };
    connect();

    const input = term.onData((data) => {
      if (ended) {
        connect();
        return;
      }
      echo.input(data);
      terminal.input(sessionId, data);
    });
    const resize = term.onResize(({ cols, rows }) => terminal.resize(sessionId, cols, rows));
    const observer = new ResizeObserver(() => fit.fit());
    observer.observe(element);
    term.focus();

    return () => {
      observer.disconnect();
      input.dispose();
      resize.dispose();
      stop?.();
      term.dispose();
    };
  }, [sessionId]);

  return <div ref={container} className="h-full w-full px-2 py-1" data-testid="terminal" />;
}
