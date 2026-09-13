/**
 * THE HUD — the whole organization on one screen:
 *
 * - LEFT: INBOUND — the valve. Events from the world land here, HELD;
 *   nothing reaches the manager until a human releases it (or the
 *   valve is flipped to auto). Always visible: you SEE what's coming.
 * - CENTER: the ROOT CHANNEL — the one conversation between the human
 *   and the Head (`Head:root`), streaming.
 * - RIGHT: ENGINEERING — the manager at work: its live session feed,
 *   the task ledger moving todo → done, and the proposals awaiting
 *   the humans' click.
 *
 * OVERLAYS (query-param addressed, lib/routes.ts): a teammate's
 * session (`?agent=`), a workspace's terminal (`?workspace=`), a
 * call's joinable thread (`?call=`).
 *
 * The company's structure is CODE (services/root/src); this screen is
 * its mission control.
 */
import { ChatView } from "@/components/chat";
import { CallThread } from "@/components/call";
import { EngineeringPane } from "@/components/engineering";
import { SessionModelSelect } from "@/components/model-select";
import { GhosttyTerminal } from "@/components/terminal";
import { TriagePanel } from "@/components/triage";
import {
  OVERLAY_EVENT,
  overlayFromLocation,
  showOverlay,
  type Overlay,
} from "@/lib/routes";
import { useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { Moon, PanelLeft, PanelRight, Sun, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

/** The Root channel's session id — the Head's one session. */
const ROOT_CHAT = "Head:root";

const OverlayShell = ({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) => (
  <div
    className="absolute inset-0 z-40 flex items-center justify-center bg-background/60 p-4 backdrop-blur-sm"
    onClick={() => showOverlay(undefined)}
  >
    <div
      className="flex h-full max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-lg border border-border bg-background shadow-lg"
      onClick={(event) => event.stopPropagation()}
    >
      <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
        <span className="truncate font-mono text-xs text-muted-foreground">
          {title}
        </span>
        <button
          type="button"
          onClick={() => showOverlay(undefined)}
          aria-label="close overlay"
          className="flex size-6 cursor-pointer items-center justify-center rounded hover:bg-accent"
        >
          <X className="size-3.5" />
        </button>
      </div>
      {children}
    </div>
  </div>
);

const OverlayView = ({ overlay }: { overlay: Overlay }) => {
  switch (overlay.kind) {
    case "agent":
      return (
        <OverlayShell title={overlay.id}>
          <ChatView id={overlay.id} active={false} readOnly />
        </OverlayShell>
      );
    case "workspace":
      return (
        <OverlayShell title={`workspace ${overlay.name} — its machine`}>
          <GhosttyTerminal
            sessionId={`Workspace:root::ws-${overlay.name}`}
            ptyId="main"
            active
          />
        </OverlayShell>
      );
    case "call":
      return (
        <OverlayShell title={`call ${overlay.id}`}>
          <CallThread id={overlay.id} />
        </OverlayShell>
      );
    case "triage":
      // the valve lives in the left pane now; the deep link survives
      return (
        <OverlayShell title="triage — the inbound valve">
          <TriagePanel />
        </OverlayShell>
      );
  }
};

export const App = () => {
  const [overlay, setOverlay] = useState<Overlay | undefined>(() =>
    overlayFromLocation(),
  );
  const [showInbound, setShowInbound] = useState(true);
  const [showEngineering, setShowEngineering] = useState(true);
  const { resolved, toggle } = useTheme();
  const ThemeIcon = resolved === "dark" ? Moon : Sun;

  useEffect(() => {
    const sync = () => setOverlay(overlayFromLocation());
    window.addEventListener("popstate", sync);
    window.addEventListener(OVERLAY_EVENT, sync);
    return () => {
      window.removeEventListener("popstate", sync);
      window.removeEventListener(OVERLAY_EVENT, sync);
    };
  }, []);

  return (
    <div className="relative flex h-dvh flex-col bg-background text-foreground">
      <header className="flex shrink-0 items-center justify-between border-b border-border px-3 py-1.5">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowInbound((current) => !current)}
            aria-label="toggle the inbound pane"
            className={cn(
              "flex size-6 cursor-pointer items-center justify-center rounded hover:bg-accent",
              !showInbound && "text-muted-foreground",
            )}
          >
            <PanelLeft className="size-4" />
          </button>
          <span className="text-sm font-semibold tracking-tight">root</span>
          <span className="text-[11px] text-muted-foreground">
            the company
          </span>
        </div>
        <div className="flex items-center gap-1">
          <SessionModelSelect sessionId={ROOT_CHAT} label="model" size="sm" />
          <button
            type="button"
            onClick={toggle}
            aria-label="toggle theme"
            className="flex size-7 cursor-pointer items-center justify-center rounded-md hover:bg-accent"
          >
            <ThemeIcon className="size-4" />
          </button>
          <button
            type="button"
            onClick={() => setShowEngineering((current) => !current)}
            aria-label="toggle the engineering pane"
            className={cn(
              "flex size-6 cursor-pointer items-center justify-center rounded hover:bg-accent",
              !showEngineering && "text-muted-foreground",
            )}
          >
            <PanelRight className="size-4" />
          </button>
        </div>
      </header>
      <main className="flex min-h-0 flex-1">
        {showInbound && (
          <aside
            aria-label="Inbound"
            className="flex w-[300px] shrink-0 flex-col border-r border-border"
          >
            <TriagePanel />
          </aside>
        )}
        <section className="flex min-h-0 min-w-0 flex-1 flex-col">
          <ChatView
            id={ROOT_CHAT}
            active={overlay === undefined}
            placeholder="Talk to the Head…"
          />
        </section>
        {showEngineering && (
          <aside
            aria-label="Engineering"
            className="flex w-[380px] shrink-0 flex-col border-l border-border"
          >
            <EngineeringPane active={false} />
          </aside>
        )}
      </main>
      {overlay !== undefined && <OverlayView overlay={overlay} />}
    </div>
  );
};
