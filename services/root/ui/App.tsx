/**
 * THE APP — one page: the ROOT CHANNEL, the conversation between the
 * human and the Head (the `Head:root` session — streaming transcript,
 * tool cards, composer). Everything else is an OVERLAY over it,
 * addressed by query params (lib/routes.ts):
 *
 * - a teammate's session (`?agent=`) — any ask card's target, read-only
 * - a workspace's terminal (`?workspace=`) — the machine's door
 * - a call's live thread (`?call=`) — watch the members talk, join in
 *
 * The company's structure is CODE (services/root/src); this window is
 * only its conversation.
 */
import { ChatView } from "@/components/chat";
import { CallThread } from "@/components/call";
import { TriagePanel, useTriage } from "@/components/triage";
import { GhosttyTerminal } from "@/components/terminal";
import { SessionModelSelect } from "@/components/model-select";
import { useTheme } from "@/lib/theme";
import {
  OVERLAY_EVENT,
  overlayFromLocation,
  showOverlay,
  type Overlay,
} from "@/lib/routes";
import { Moon, Sun, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

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
  const { resolved, toggle } = useTheme();
  const ThemeIcon = resolved === "dark" ? Moon : Sun;
  const triage = useTriage();

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
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-semibold tracking-tight">root</span>
          <span className="text-[11px] text-muted-foreground">
            the company's channel
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => showOverlay({ kind: "triage" })}
            aria-label={
              triage === undefined
                ? "triage"
                : `triage, ${triage.held.length} held`
            }
            title="the inbound valve — held events wait for your release"
            className={cn(
              "flex cursor-pointer items-center gap-1.5 rounded-md border border-border/60 px-2 py-0.5 font-mono text-[11px] hover:bg-accent",
              (triage?.held.length ?? 0) > 0 &&
                "border-moss text-foreground",
            )}
          >
            triage
            <span
              className={cn(
                "rounded px-1",
                (triage?.held.length ?? 0) > 0
                  ? "bg-moss/20"
                  : "bg-muted text-muted-foreground",
              )}
            >
              {triage?.held.length ?? "…"}
            </span>
          </button>
          <SessionModelSelect sessionId={ROOT_CHAT} label="model" size="sm" />
          <button
            type="button"
            onClick={toggle}
            aria-label="toggle theme"
            className="flex size-7 cursor-pointer items-center justify-center rounded-md hover:bg-accent"
          >
            <ThemeIcon className="size-4" />
          </button>
        </div>
      </header>
      <main className="flex min-h-0 flex-1 flex-col">
        <ChatView
          id={ROOT_CHAT}
          active={overlay === undefined}
          placeholder="Talk to the Head…"
        />
      </main>
      {overlay !== undefined && <OverlayView overlay={overlay} />}
    </div>
  );
};
