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
import { AppTabs } from "@/components/app-tabs";
import { ChannelFeed, ThreadView } from "@/components/channel-feed";
import { CodeBrowser } from "@/components/code-browser";
import { WorkPage } from "@/components/issues";
import { TaskBoard } from "@/components/task-board";
import { TaskPage } from "@/components/task-page";
import { DeskView } from "@/components/desk-view";
import { PaneContext } from "@/components/pane-context";
import { CallThread } from "@/components/call";
import { MembersPanel } from "@/components/members";
import { AgentProfile } from "@/components/agent-profile";

import { Avatar, KindBadge, sessionAuthor } from "@/components/avatar";
import { GhosttyTerminal } from "@/components/terminal";
import { fetchOrg } from "@/lib/org";
import {
  agentFromLocation,
  channelFromLocation,
  normalizeLegacyLocation,
  OVERLAY_EVENT,
  closePane,
  overlayFromLocation,
  panesFromLocation,
  showChannel,
  showOverlay,
  codeFromLocation,
  tabFromLocation,
  tasksFromLocation,
  threadFromLocation,
  workFromLocation,
  type AgentPlace,
  type AppTab,
  type CodePlace,
  type Overlay,
  type Pane,
  type TasksPlace,
  type WorkPlace,
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
  Wrench,
  X,
} from "lucide-react";
import {
  useRef,
  Fragment,
  useEffect,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

interface Channel {
  readonly name: string;
  readonly chat: string;
  /** A DM — the human's private line to one agent; opened from the
   *  rail's agent rows, never listed under CHANNELS. */
  readonly dm?: boolean;
}

/** The code-declared channels, until /api/channels answers. */
const FALLBACK: ReadonlyArray<Channel> = [
  { name: "root", chat: "Head:root" },
  {
    name: "engineering",
    chat: "Manager:root::manager",
  },
  { name: "head", chat: "Head:root", dm: true },
  { name: "manager", chat: "Manager:root::manager", dm: true },
  { name: "engineer", chat: "Engineer:root::engineer", dm: true },
  { name: "reviewer", chat: "Reviewer:root::reviewer", dm: true },
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

/**
 * An agent's WORKING — the rightmost finder column: the session's
 * sequence (thinking traces, messages, tool calls), split open by
 * clicking the agent in a thread (or anywhere it is named).
 */
const AgentColumn = ({ id }: { id: string }) => {
  // a per-invocation session's key ends with the ask's post id — the
  // thread panel beside this column already shows that message, so
  // the column suppresses the duplicate delivered copy
  const invocation = id.split("::").pop();
  // WHO is working here — the header names the agent, not the
  // session's internal id
  const author = sessionAuthor(id);
  return (
    <section
      aria-label="agent session"
      className="flex min-h-0 min-w-0 flex-1 flex-col bg-background"
    >
      <header className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-1.5">
        <div className="flex min-w-0 items-center gap-2">
          <Avatar name={author.name} kind={author.kind} size={20} />
          <span className="truncate font-mono text-xs font-semibold">
            {author.name}
          </span>
          <KindBadge kind={author.kind} />
          <Wrench
            className="size-3 shrink-0 text-muted-foreground"
            aria-label="an agent's working"
          />
        </div>
        <button
          type="button"
          onClick={() => closePane({ kind: "agent", id })}
          aria-label="close the agent column"
          className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded hover:bg-accent"
        >
          <X className="size-3.5" />
        </button>
      </header>
      <ChatView
        id={id}
        active={false}
        readOnly
        flat
        {...(invocation !== undefined && invocation.startsWith("p-")
          ? { hideInput: invocation }
          : {})}
      />
    </section>
  );
};

/**
 * A workspace's TERMINAL — a finder column like the agent's working
 * (never a modal): a real shell on the workspace's machine, split to
 * the right, closing back to whatever was beside it.
 */
const WorkspaceColumn = ({ name }: { name: string }) => (
  <section
    aria-label="workspace terminal"
    className="flex min-h-0 min-w-0 flex-1 flex-col bg-background"
  >
    <header className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-1.5">
      <span className="truncate font-mono text-xs text-muted-foreground">
        workspace {name} — its machine
      </span>
      <button
        type="button"
        onClick={() => closePane({ kind: "workspace", name })}
        aria-label="close the workspace column"
        className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded hover:bg-accent"
      >
        <X className="size-3.5" />
      </button>
    </header>
    <GhosttyTerminal
      sessionId={`Workspace:root::ws-${name}`}
      ptyId="main"
      active
    />
  </section>
);

const OverlayView = ({ overlay }: { overlay: Overlay }) => {
  switch (overlay.kind) {
    case "agent":
      return null; // a finder COLUMN, not a modal — see AgentColumn
    case "workspace":
      return null; // a finder COLUMN, not a modal — see WorkspaceColumn
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
  /** The TOP TAB — Chat (the whole chat app), Code, Issues, Pulls. */
  const [tab, setTab] = useState<AppTab>(() => tabFromLocation());
  const [codePlace, setCodePlace] = useState<CodePlace>(() =>
    codeFromLocation(),
  );
  const [workPlace, setWorkPlace] = useState<WorkPlace>(() =>
    workFromLocation(),
  );
  const [tasksPlace, setTasksPlace] = useState<TasksPlace>(() =>
    tasksFromLocation(),
  );
  const [overlay, setOverlay] = useState<Overlay | undefined>(() =>
    overlayFromLocation(),
  );
  /** The PANE STACK — the column right-adjacent to the thread,
   *  tmux-shaped: every "Worked for"/workspace click appends a
   *  VERTICAL split here; each pane closes on its own. */
  const [panes, setPanes] = useState<ReadonlyArray<Pane>>(() =>
    panesFromLocation(),
  );
  /** The open agent PROFILE (`/a/:name/:tab?/:item?`) — the org's
   *  mirror page, tab and selected card in the path. */
  const [agent, setAgent] = useState<AgentPlace | undefined>(() =>
    agentFromLocation(),
  );
  /** The AGENTS rail section — the roster from `/api/org`. */
  const [roster, setRoster] = useState<
    ReadonlyArray<{ name: string; slug: string; model: string | undefined }>
  >([]);
  /** The OPEN thread — discord's side panel, riding the path. */
  const [thread, setThread] = useState<string | undefined>(() =>
    threadFromLocation(),
  );
  /** Every thread OPENED this session stays MOUNTED (hidden when not
   *  the open one) — switching between threads shows each exactly as
   *  last left (scroll, draft), never a re-render's scroll dance. */
  const [openedThreads, setOpenedThreads] = useState<
    ReadonlyArray<{ id: string; channel: string; chat: string }>
  >([]);
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
    () => channelFromLocation() ?? "root",
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
    fetchOrg()
      .then((graph) =>
        setRoster(
          graph.agents.map((entry) => ({
            name: entry.name,
            slug: entry.slug,
            model: entry.model?.label,
          })),
        ),
      )
      .catch(() => {});
  }, []);

  useEffect(() => {
    const sync = () => {
      setTab(tabFromLocation());
      setCodePlace(codeFromLocation());
      setWorkPlace(workFromLocation());
      setTasksPlace(tasksFromLocation());
      setOverlay(overlayFromLocation());
      setPanes(panesFromLocation());
      setAgent(agentFromLocation());
      setThread(threadFromLocation());
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

  // remember every thread opened here — the panel cache's keys
  useEffect(() => {
    if (thread === undefined) return;
    setOpenedThreads((current) =>
      current.some((entry) => entry.id === thread)
        ? current
        : [
            ...current,
            { id: thread, channel: channel.name, chat: channel.chat },
          ],
    );
  }, [thread, channel.name, channel.chat]);

  useEffect(() => {
    window.localStorage.setItem("root:rail-width", String(railWidth));
  }, [railWidth]);

  /** COLUMN sizes as PROPORTIONAL weights (feed : thread : panes),
   *  not pixels — a column that appears or closes renormalizes the
   *  shares, so a 50/50 split becomes thirds when a third column
   *  opens instead of crushing the others. Remembered. */
  const [colWeights, setColWeights] = useState<{
    feed: number;
    thread: number;
    panes: number;
  }>(() => {
    try {
      const stored = JSON.parse(
        window.localStorage.getItem("root:col-weights") ?? "",
      ) as { feed?: number; thread?: number; panes?: number };
      const ok = (value: unknown): value is number =>
        typeof value === "number" && Number.isFinite(value) && value > 0;
      if (ok(stored.feed) && ok(stored.thread) && ok(stored.panes)) {
        return {
          feed: stored.feed,
          thread: stored.thread,
          panes: stored.panes,
        };
      }
    } catch {
      // first run (or the old px keys) — equal shares
    }
    return { feed: 1, thread: 1, panes: 1 };
  });
  useEffect(() => {
    window.localStorage.setItem("root:col-weights", JSON.stringify(colWeights));
  }, [colWeights]);

  /** Weights of the pane COLUMNS — one per pane, dragged at the
   *  dividers between them; a new pane arrives at weight 1. */
  const [paneWeights, setPaneWeights] = useState<ReadonlyArray<number>>([]);
  useEffect(() => {
    setPaneWeights((current) =>
      current.length === panes.length
        ? current
        : panes.map((_, index) => current[index] ?? 1),
    );
  }, [panes]);
  const stackRef = useRef<HTMLElement | null>(null);

  /** One drag: deltas from the pointer-down, until release. */
  const dragFrom = (
    down: ReactPointerEvent,
    axis: "x" | "y",
    apply: (delta: number) => void,
  ) => {
    down.preventDefault();
    const start = axis === "x" ? down.clientX : down.clientY;
    const move = (event: PointerEvent) =>
      apply((axis === "x" ? event.clientX : event.clientY) - start);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const clampShare = (value: number) => Math.min(6, Math.max(0.2, value));

  /** A column divider: the two NEIGHBORS trade share, converted from
   *  the pointer's px delta through their live geometry. */
  const startColDrag = (
    down: ReactPointerEvent,
    left: "feed" | "thread",
    right: "thread" | "panes",
  ) => {
    const leftEl =
      left === "feed"
        ? document.querySelector("section[data-column=feed]")
        : document.querySelector("aside[aria-label=thread]:not(.hidden)");
    const rightEl =
      right === "panes"
        ? document.querySelector("aside[aria-label=panes]")
        : document.querySelector("aside[aria-label=thread]:not(.hidden)");
    if (!(leftEl instanceof HTMLElement) || !(rightEl instanceof HTMLElement)) {
      return;
    }
    const from = { ...colWeights };
    const pxPerWeight =
      (leftEl.getBoundingClientRect().width +
        rightEl.getBoundingClientRect().width) /
      (from[left] + from[right]);
    if (!Number.isFinite(pxPerWeight) || pxPerWeight <= 0) return;
    dragFrom(down, "x", (dx) => {
      const dw = dx / pxPerWeight;
      setColWeights({
        ...from,
        [left]: clampShare(from[left] + dw),
        [right]: clampShare(from[right] - dw),
      });
    });
  };

  /** Divider inside the pane stack: the two adjacent pane COLUMNS
   *  trade width. */
  const startRowDrag = (down: ReactPointerEvent, above: number) => {
    const stack = stackRef.current;
    if (stack === null) return;
    const total = paneWeights.reduce((sum, weight) => sum + weight, 0) || 1;
    const pxPerWeight = stack.clientWidth / total;
    const from = [...paneWeights];
    const clampWeight = (value: number) => Math.min(8, Math.max(0.15, value));
    dragFrom(down, "x", (dx) => {
      const dw = dx / pxPerWeight;
      setPaneWeights(
        from.map((weight, index) =>
          index === above
            ? clampWeight(weight + dw)
            : index === above + 1
              ? clampWeight(weight - dw)
              : weight,
        ),
      );
    });
  };

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
      {/* the org, four ways: Chat | Code | Issues | Pulls */}
      <AppTabs tab={tab} />
      {tab === "code" ? (
        <CodeBrowser place={codePlace} />
      ) : tab === "issues" ? (
        <WorkPage kind="issues" place={workPlace} />
      ) : tab === "pulls" ? (
        <WorkPage kind="pulls" place={workPlace} />
      ) : tab === "tasks" ? (
        <div className="relative flex min-h-0 flex-1">
          {tasksPlace.queue !== undefined && tasksPlace.desk !== undefined ? (
            <DeskView queue={tasksPlace.queue} agent={tasksPlace.desk} />
          ) : tasksPlace.queue !== undefined &&
            tasksPlace.task !== undefined ? (
            <TaskPage queue={tasksPlace.queue} id={tasksPlace.task} />
          ) : (
            <TaskBoard queue={tasksPlace.queue} />
          )}
          {/* the PANE STACK, tasks-flavored: "Worked for" chips, origin
            `post:` chips, and branch buttons split sessions and threads
            open here — same tokens (`?panes=`), simpler chrome (equal
            splits, no drag) */}
          {panes.length > 0 && (
            <aside
              aria-label="panes"
              className="flex min-h-0 min-w-0 flex-1 flex-row overflow-x-auto border-l border-border max-md:absolute max-md:inset-0 max-md:z-40"
              style={{ flexGrow: 1, flexBasis: 0 }}
            >
              {panes.map((pane) => (
                <div
                  key={
                    pane.kind === "agent"
                      ? `a:${pane.id}`
                      : pane.kind === "workspace"
                        ? `w:${pane.name}`
                        : `p:${pane.channel}:${pane.id}`
                  }
                  className="flex min-h-0 min-w-[20rem] flex-1 flex-col border-l border-border first:border-l-0"
                >
                  <PaneContext.Provider value={pane}>
                    {pane.kind === "agent" ? (
                      <AgentColumn id={pane.id} />
                    ) : pane.kind === "workspace" ? (
                      <WorkspaceColumn name={pane.name} />
                    ) : (
                      <ThreadView
                        channel={pane.channel}
                        chat={
                          channels.find((entry) => entry.name === pane.channel)
                            ?.chat ?? ""
                        }
                        id={pane.id}
                        onClose={() => closePane(pane)}
                      />
                    )}
                  </PaneContext.Provider>
                </div>
              ))}
            </aside>
          )}
        </div>
      ) : (
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
              {channels
                .filter((entry) => !entry.dm)
                .map((entry) => (
                  <div key={entry.name} className="flex flex-col gap-0.5">
                    <button
                      type="button"
                      onClick={() => pick(entry.name)}
                      aria-label={`open the ${entry.name} channel`}
                      className={cn(
                        "flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-[13px]",
                        // ONE selection in the rail: an open profile takes
                        // it; the channel stays only background context
                        agent === undefined && entry.name === channel.name
                          ? "bg-accent font-medium"
                          : "text-muted-foreground hover:bg-accent/60",
                      )}
                    >
                      <Hash className="size-3.5 shrink-0" />
                      {entry.name}
                    </button>
                  </div>
                ))}
              {/* the AGENTS — the roster as DMs: clicking one opens
                the human's private line to that agent (its DM
                channel). Profiles live on the RIGHT sidebar's
                member rows (`/a/:name`). */}
              {roster.length > 0 && (
                <div className="flex flex-col gap-0.5 pt-3">
                  <div className="px-2 pb-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    agents
                  </div>
                  {roster.map((entry) => (
                    <button
                      key={entry.name}
                      type="button"
                      onClick={() => pick(entry.slug)}
                      aria-label={`open the DM with ${entry.slug}`}
                      title={entry.model}
                      className={cn(
                        "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-[13px]",
                        agent === undefined && channel.name === entry.slug
                          ? "bg-accent font-medium"
                          : "text-muted-foreground hover:bg-accent/60",
                      )}
                    >
                      <Avatar name={entry.slug} kind="agent" size={18} />
                      <span className="min-w-0 flex-1 truncate text-left">
                        {entry.slug}
                      </span>
                      <span
                        aria-hidden
                        title={entry.model}
                        className="size-1.5 shrink-0 rounded-full bg-moss/70"
                      />
                    </button>
                  ))}
                </div>
              )}
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

          {/* the center: an agent's PROFILE (the org's mirror page),
            the focused THREAD (the tweet-permalink move — a thread
            opens as the main view, not a side panel), or the channel
            feed */}
          {agent !== undefined ? (
            <AgentProfile
              key={agent.name}
              name={agent.name}
              tab={agent.tab}
              item={agent.item}
              onUp={() => showChannel(channel.name)}
            />
          ) : channel.dm ? (
            /* a DM wears the SAME surface as the profile — one header,
             Chat the active tab, the feed as its body */
            <AgentProfile
              key={`dm-${channel.name}`}
              name={channel.name}
              tab="chat"
              onUp={() => pick("root")}
              chat={
                <ChannelFeed
                  key={channel.name}
                  channel={channel.name}
                  chat={channel.chat}
                  dm
                  placeholder={`Message @${channel.name}…`}
                />
              }
            />
          ) : (
            <section
              data-column="feed"
              style={{ flexGrow: colWeights.feed, flexBasis: 0 }}
              className="flex min-h-0 min-w-[220px] flex-col"
            >
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
              <ChannelFeed
                key={channel.name}
                channel={channel.name}
                chat={channel.chat}
                placeholder={`Message #${channel.name}…`}
                filter={search}
              />
            </section>
          )}

          {/* the OPEN thread — a finder column split to the right; its
            composer speaks into the thread. Every thread ever opened
            stays mounted, hidden — switching back shows it exactly
            as last left. */}
          {thread !== undefined && (
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="resize the thread"
              onPointerDown={(down) => startColDrag(down, "feed", "thread")}
              className="z-10 -mx-[3px] w-1.5 shrink-0 cursor-col-resize hover:bg-border active:bg-primary/40 max-md:hidden"
            />
          )}
          {openedThreads.map((entry) => (
            <ThreadView
              key={entry.id}
              channel={entry.channel}
              chat={entry.chat}
              id={entry.id}
              active={entry.id === thread}
              weight={colWeights.thread}
            />
          ))}

          {/* the PANE STACK — MILLER COLUMNS marching right of the
            thread: agent workings, terminals, and referenced threads
            in click order. A reference clicked inside a pane splits
            right-adjacent to it; the chain grows arbitrarily far
            right (the stack scrolls) and is never blown away. */}
          {panes.length > 0 && (
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="resize the panes"
              onPointerDown={(down) =>
                startColDrag(
                  down,
                  thread !== undefined ? "thread" : "feed",
                  "panes",
                )
              }
              className="z-10 -mx-[3px] w-1.5 shrink-0 cursor-col-resize hover:bg-border active:bg-primary/40 max-md:hidden"
            />
          )}
          {panes.length > 0 && (
            <aside
              ref={stackRef}
              aria-label="panes"
              style={{ flexGrow: colWeights.panes, flexBasis: 0 }}
              className="flex min-h-0 min-w-0 flex-row overflow-x-auto border-l border-border max-md:absolute max-md:inset-0 max-md:z-40"
            >
              {panes.map((pane, index) => (
                <Fragment
                  key={
                    pane.kind === "agent"
                      ? `a:${pane.id}`
                      : pane.kind === "workspace"
                        ? `w:${pane.name}`
                        : `p:${pane.channel}:${pane.id}`
                  }
                >
                  {index > 0 && (
                    <div
                      role="separator"
                      aria-orientation="vertical"
                      aria-label="resize the pane"
                      onPointerDown={(down) => startRowDrag(down, index - 1)}
                      className="z-10 -mx-[3px] w-1.5 shrink-0 cursor-col-resize border-l border-border hover:bg-border active:bg-primary/40"
                    />
                  )}
                  <div
                    style={{
                      flexGrow: paneWeights[index] ?? 1,
                      flexShrink: 1,
                      flexBasis: 0,
                    }}
                    className="flex min-h-0 min-w-[20rem] flex-col"
                  >
                    {/* the pane knows ITSELF — a reference clicked
                      inside opens right-adjacent to it */}
                    <PaneContext.Provider value={pane}>
                      {pane.kind === "agent" ? (
                        <AgentColumn id={pane.id} />
                      ) : pane.kind === "workspace" ? (
                        <WorkspaceColumn name={pane.name} />
                      ) : (
                        <ThreadView
                          channel={pane.channel}
                          chat={
                            channels.find(
                              (entry) => entry.name === pane.channel,
                            )?.chat ?? ""
                          }
                          id={pane.id}
                          onClose={() => closePane(pane)}
                        />
                      )}
                    </PaneContext.Provider>
                  </div>
                </Fragment>
              ))}
            </aside>
          )}

          {/* WHO is here — humans and agents, discord's member list.
            A room's furniture: profiles and DMs are about ONE agent,
            so the panel stays out of them. */}
          {members &&
            thread === undefined &&
            panes.length === 0 &&
            agent === undefined &&
            !channel.dm && <MembersPanel channel={channel.name} />}
        </div>
      )}
      {overlay !== undefined && <OverlayView overlay={overlay} />}
    </div>
  );
};
