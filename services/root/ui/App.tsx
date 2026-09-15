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
import { MembersPanel } from "@/components/members";
import { ChannelThreads, TaskThread } from "@/components/tasks";
import { GhosttyTerminal } from "@/components/terminal";
import {
  channelFromLocation,
  normalizeLegacyLocation,
  OVERLAY_EVENT,
  overlayFromLocation,
  showChannel,
  showOverlay,
  taskFromLocation,
  type Overlay,
} from "@/lib/routes";
import { useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import {
  Hash,
  Moon,
  Pause,
  Play,
  Search,
  Sun,
  Users,
  X,
} from "lucide-react";
import {
  useEffect,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

interface Channel {
  readonly name: string;
  readonly chat: string;
}

/** The code-declared channels, until /api/channels answers. */
const FALLBACK: ReadonlyArray<Channel> = [
  { name: "root", chat: "Head:root" },
  {
    name: "engineering",
    chat: "Manager:root::manager",
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

const RAIL_MIN = 160;
const RAIL_MAX = 480;

// before any state reads the location: old query urls become paths
normalizeLegacyLocation();

export const App = () => {
  const [overlay, setOverlay] = useState<Overlay | undefined>(() =>
    overlayFromLocation(),
  );
  const [task, setTask] = useState<string | undefined>(() =>
    taskFromLocation(),
  );
  /** The transcript search, per channel — cleared on channel switch. */
  const [search, setSearch] = useState("");
  /** The members panel — who's in the channel; remembered. */
  const [members, setMembers] = useState(
    () => window.localStorage.getItem("root:members") !== "0",
  );
  /** The rail's width — draggable, remembered. */
  const [railWidth, setRailWidth] = useState(() => {
    const stored = Number(window.localStorage.getItem("root:rail-width"));
    return Number.isFinite(stored) && stored >= RAIL_MIN ? stored : 208;
  });
  const [channels, setChannels] = useState<ReadonlyArray<Channel>>(FALLBACK);
  const [selected, setSelected] = useState<string>(
    // a task permalink loads with the ledger's home channel behind it
    // — that's where its threads live in the rail
    () =>
      channelFromLocation() ??
      (taskFromLocation() !== undefined ? "engineering" : "root"),
  );
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
      const name = channelFromLocation();
      if (name !== undefined) setSelected(name);
    };
    window.addEventListener("popstate", sync);
    window.addEventListener(OVERLAY_EVENT, sync);
    return () => {
      window.removeEventListener("popstate", sync);
      window.removeEventListener(OVERLAY_EVENT, sync);
    };
  }, []);

  const pick = (name: string) => {
    setSearch("");
    showChannel(name); // the path change also leaves any /t/ focus
  };

  const channel =
    channels.find((entry) => entry.name === selected) ?? channels[0]!;

  useEffect(() => {
    window.localStorage.setItem("root:rail-width", String(railWidth));
  }, [railWidth]);

  /** Drag the rail's right edge to resize it. */
  const startRailDrag = (down: ReactPointerEvent) => {
    down.preventDefault();
    const startX = down.clientX;
    const startWidth = railWidth;
    const move = (event: PointerEvent) =>
      setRailWidth(
        Math.min(
          RAIL_MAX,
          Math.max(RAIL_MIN, startWidth + event.clientX - startX),
        ),
      );
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div className="relative flex h-dvh flex-col bg-background text-foreground">
      <div className="relative flex min-h-0 flex-1">
        {/* the rail: one channel per group — the org chart, as rooms */}
        <nav
          aria-label="Channels"
          style={{ width: railWidth }}
          className="relative flex shrink-0 flex-col border-r border-border bg-muted/20"
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
          {/* the resize handle — drag the rail's edge */}
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="resize the sidebar"
            onPointerDown={startRailDrag}
            className="absolute inset-y-0 -right-0.5 z-10 w-1.5 cursor-col-resize hover:bg-border active:bg-border"
          />
        </nav>

        {/* the center: the focused THREAD (the tweet-permalink move —
            a thread opens as the main view, not a side panel), or the
            channel feed */}
        {task !== undefined ? (
          <TaskThread
            key={task}
            id={task}
            channel={channel.name}
            onUp={() => showChannel(channel.name)}
          />
        ) : (
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
              <button
                type="button"
                onClick={() => {
                  const next = !members;
                  setMembers(next);
                  window.localStorage.setItem(
                    "root:members",
                    next ? "1" : "0",
                  );
                }}
                aria-label="toggle the member list"
                aria-pressed={members}
                className={cn(
                  "flex size-6 cursor-pointer items-center justify-center rounded hover:bg-accent",
                  members ? "text-foreground" : "text-muted-foreground",
                )}
              >
                <Users className="size-3.5" />
              </button>
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
        )}

        {/* WHO is here — humans and agents, discord's member list */}
        {members && <MembersPanel channel={channel.name} />}
      </div>
      {overlay !== undefined && <OverlayView overlay={overlay} />}
    </div>
  );
};
