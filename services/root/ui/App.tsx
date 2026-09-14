/**
 * THE APP — slack-shaped: a rail of CHANNELS, one per `AI.Group`
 * (every group's channel is its head's session), and the selected
 * channel's conversation. That's the whole surface.
 *
 * - `#root` — the Root Group: you ↔ the Head.
 * - `#engineering` — the Engineering group: GitHub events arrive here
 *   as messages and the manager works them one by one, like any other
 *   channel traffic. STOP parks the channel (events queue durably);
 *   RESUME picks the backlog back up.
 *
 * OVERLAYS (query-param addressed, lib/routes.ts): a teammate's
 * session (`?agent=`), a workspace's terminal (`?workspace=`), a
 * call's joinable thread (`?call=`). The ask-tree cards live inside
 * each channel's transcript.
 */
import { ChatView } from "@/components/chat";
import { CallThread } from "@/components/call";
import { SessionModelSelect } from "@/components/model-select";
import { ChannelThreads, TaskPanel } from "@/components/tasks";
import { GhosttyTerminal } from "@/components/terminal";
import {
  OVERLAY_EVENT,
  overlayFromLocation,
  showOverlay,
  taskFromLocation,
  type Overlay,
} from "@/lib/routes";
import { useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { Hash, Moon, Pause, Play, Search, Sun, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

interface Channel {
  readonly name: string;
  readonly chat: string;
}

/** The code-declared channels, until /api/channels answers. */
const FALLBACK: ReadonlyArray<Channel> = [
  { name: "root", chat: "Head:root" },
  {
    name: "engineering",
    chat: "EngineeringManager:root::engineering-manager",
  },
];

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
  }
};

/** The channel's pause switch — STOP parks the session (its round is
 *  cut, inputs queue durably), RESUME picks the backlog back up. */
const StopResume = ({ chat }: { chat: string }) => {
  const [stopped, setStopped] = useState(false);
  const [busy, setBusy] = useState(false);
  const flip = () => {
    const verb = stopped ? "resume" : "stop";
    setBusy(true);
    fetch(`/api/chats/${encodeURIComponent(chat)}/${verb}`, { method: "POST" })
      .then((response) => {
        if (response.ok) setStopped(!stopped);
      })
      .finally(() => setBusy(false));
  };
  const Icon = stopped ? Play : Pause;
  return (
    <button
      type="button"
      onClick={flip}
      disabled={busy}
      aria-label={stopped ? "resume the channel" : "stop the channel"}
      title={
        stopped
          ? "resume — work through the backlog"
          : "stop — park the channel; messages queue"
      }
      className={cn(
        "flex cursor-pointer items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] disabled:opacity-50",
        stopped
          ? "border-moss bg-moss/10 text-foreground"
          : "border-border/60 text-muted-foreground hover:bg-accent",
      )}
    >
      <Icon className="size-3" />
      {stopped ? "resume" : "stop"}
    </button>
  );
};

export const App = () => {
  const [overlay, setOverlay] = useState<Overlay | undefined>(() =>
    overlayFromLocation(),
  );
  const [task, setTask] = useState<string | undefined>(() =>
    taskFromLocation(),
  );
  /** The transcript search, per channel — cleared on channel switch. */
  const [search, setSearch] = useState("");
  const [channels, setChannels] = useState<ReadonlyArray<Channel>>(FALLBACK);
  const [selected, setSelected] = useState<string>(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get("channel") ?? "root";
  });
  const { resolved, toggle } = useTheme();
  const ThemeIcon = resolved === "dark" ? Moon : Sun;

  useEffect(() => {
    fetch("/api/channels")
      .then(async (response) => {
        if (!response.ok) return;
        const body = (await response.json()) as { channels: Channel[] };
        if (body.channels.length > 0) setChannels(body.channels);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const sync = () => {
      setOverlay(overlayFromLocation());
      setTask(taskFromLocation());
    };
    window.addEventListener("popstate", sync);
    window.addEventListener(OVERLAY_EVENT, sync);
    return () => {
      window.removeEventListener("popstate", sync);
      window.removeEventListener(OVERLAY_EVENT, sync);
    };
  }, []);

  const pick = (name: string) => {
    setSelected(name);
    setSearch("");
    const url = name === "root" ? "/" : `/?channel=${encodeURIComponent(name)}`;
    window.history.pushState({}, "", url);
    // the URL above drops ?task, so the panel closes with the switch
    setTask(undefined);
  };

  const channel =
    channels.find((entry) => entry.name === selected) ?? channels[0]!;

  return (
    <div className="relative flex h-dvh flex-col bg-background text-foreground">
      <div className="relative flex min-h-0 flex-1">
        {/* the rail: one channel per group — the org chart, as rooms */}
        <nav
          aria-label="Channels"
          className="flex w-[200px] shrink-0 flex-col border-r border-border bg-muted/20"
        >
          <div className="flex items-center justify-between px-3 py-2">
            <span className="text-sm font-semibold tracking-tight">root</span>
            <button
              type="button"
              onClick={toggle}
              aria-label="toggle theme"
              className="flex size-6 cursor-pointer items-center justify-center rounded hover:bg-accent"
            >
              <ThemeIcon className="size-3.5" />
            </button>
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-2">
            {channels.map((entry) => (
              <div key={entry.name} className="flex flex-col gap-0.5">
                <button
                  type="button"
                  onClick={() => pick(entry.name)}
                  aria-label={`open the ${entry.name} channel`}
                  className={cn(
                    "flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-[13px]",
                    entry.name === channel.name
                      ? "bg-accent font-medium"
                      : "text-muted-foreground hover:bg-accent/60",
                  )}
                >
                  <Hash className="size-3.5 shrink-0" />
                  {entry.name}
                </button>
                {/* the channel's THREADS, nested under it — the
                    ledger has no separate board */}
                {entry.name === "engineering" && (
                  <ChannelThreads selected={task} />
                )}
              </div>
            ))}
          </div>
        </nav>

        {/* the channel */}
        <section className="flex min-h-0 min-w-0 flex-1 flex-col">
          <header className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-1.5">
            <div className="flex min-w-0 shrink-0 items-center gap-1.5">
              <Hash className="size-4 shrink-0 text-muted-foreground" />
              <span className="text-sm font-medium">{channel.name}</span>
              <span className="hidden min-w-0 truncate pl-1 font-mono text-[10px] text-muted-foreground lg:inline">
                {channel.chat}
              </span>
            </div>
            <div className="flex min-w-0 items-center gap-1.5">
              {/* search WITHIN the channel — filters the transcript */}
              <div className="flex min-w-0 items-center gap-1.5 rounded-md border border-border/60 px-2 py-0.5 focus-within:border-border">
                <Search className="size-3 shrink-0 text-muted-foreground" />
                <input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder={`search #${channel.name}…`}
                  aria-label={`search the ${channel.name} channel`}
                  className="w-24 min-w-0 bg-transparent text-[11px] outline-none placeholder:text-muted-foreground/70 md:w-36"
                />
                {search.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setSearch("")}
                    aria-label="clear the search"
                    className="flex cursor-pointer items-center text-muted-foreground hover:text-foreground"
                  >
                    <X className="size-3" />
                  </button>
                )}
              </div>
              <StopResume chat={channel.chat} />
              {/* the composer keeps the pick reachable on narrow */}
              <SessionModelSelect
                sessionId={channel.chat}
                label="model"
                size="sm"
                className="max-md:hidden"
              />
            </div>
          </header>
          <ChatView
            key={channel.chat}
            id={channel.chat}
            active={overlay === undefined}
            placeholder={`Message #${channel.name}…`}
            filter={search}
          />
        </section>

        {/* a task's THREAD — the Slack thread panel, beside the center */}
        {task !== undefined && <TaskPanel key={task} id={task} />}
      </div>
      {overlay !== undefined && <OverlayView overlay={overlay} />}
    </div>
  );
};
