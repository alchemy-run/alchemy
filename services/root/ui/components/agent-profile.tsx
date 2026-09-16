/**
 * An AGENT's PROFILE — the mirror of its declaration (`/a/:name`).
 *
 * The org is type-safe code; deploying it produces this page: the
 * charter prose (the same text the model reads) under three TABS —
 * Charter | Skills | Tools — with the tab and selected card in the
 * path (`/a/Head/tools/explore`), so a splice pill clicked anywhere
 * deep-links to the exact card. Editing the page IS editing the
 * code — except the skill switches, the one runtime dial.
 */
import { Avatar, KindBadge } from "@/components/avatar";
import { MarkdownText } from "@/components/chat";
import {
  fetchOrg,
  invalidateOrg,
  setAgentSkill,
  type OrgGraph,
  type OrgTool,
} from "@/lib/org";
import { showAgent, showChannel, type AgentTab } from "@/lib/routes";
import { cn } from "@/lib/utils";
import {
  ArrowLeft,
  Blocks,
  ChevronRight,
  Cpu,
  FileCode2,
  MessageCircle,
  ScrollText,
  Wrench,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

/**
 * DOCUMENT prose — the Notion feel: a centered column, larger type,
 * generous line height, paragraphs and lists spaced like a page.
 * Read-only, but it should read like a doc, not a chat bubble.
 */
const PROSE =
  "text-[15.5px] leading-[1.75] text-foreground/90 " +
  "[&_p]:my-3.5 [&_p:first-child]:mt-0 [&_ul]:my-3 [&_ol]:my-3 [&_li]:my-1 " +
  "[&_pre]:my-4 [&_blockquote]:my-4 [&_h1]:mt-8 [&_h2]:mt-7 [&_h3]:mt-6";
const DOC = `w-full max-w-2xl ${PROSE}`;

const Pill = ({
  children,
  tone,
  title,
}: {
  children: React.ReactNode;
  tone: "green" | "amber" | "muted" | "red";
  title?: string;
}) => (
  <span
    title={title}
    className={cn(
      "inline-flex max-w-full items-center gap-1 truncate rounded-full border px-1.5 py-px font-mono text-[10px]",
      tone === "green" && "border-moss/50 bg-moss/10 text-foreground",
      tone === "amber" && "border-amber-600/40 bg-amber-500/10",
      tone === "red" && "border-red-600/40 bg-red-500/10",
      tone === "muted" && "border-border/60 text-muted-foreground",
    )}
  >
    {children}
  </span>
);

/**
 * One COLLAPSED row of a document list — Notion's toggle block: a
 * quiet heading line (chevron, icon, name, trailing extras), the
 * body only when opened. The path's selection opens itself and
 * scrolls into view.
 */
const DocRow = ({
  selected,
  icon: Icon,
  name,
  extras,
  children,
}: {
  selected: boolean;
  icon: typeof Wrench;
  name: string;
  /** Trailing header widgets (chips, the skill switch). */
  extras?: React.ReactNode;
  children: React.ReactNode;
}) => {
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(selected);
  useEffect(() => {
    if (selected) {
      setOpen(true);
      ref.current?.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, [selected]);
  return (
    <div ref={ref} className={cn(selected && "rounded-md bg-primary/5")}>
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setOpen((current) => !current);
          }
        }}
        className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-2.5 hover:bg-accent/40"
      >
        <ChevronRight
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground/70 transition-transform",
            open && "rotate-90",
          )}
        />
        <Icon className="size-4 shrink-0 text-muted-foreground/70" />
        <span className="min-w-0 flex-1 truncate font-mono text-[15px] font-semibold tracking-tight">
          {name}
        </span>
        {extras}
      </div>
      {open && <div className="pb-5 pl-[26px] pr-1">{children}</div>}
    </div>
  );
};

/** The runtime switch — the gate the driver consults at activation
 *  (PATCH /api/org/agents/:agent/skills/:skill). Lives in the row
 *  HEADER, so it never toggles the row's expansion. */
const SkillSwitch = ({
  agent,
  name,
  enabled,
  onFlip,
}: {
  agent: string;
  name: string;
  enabled: boolean;
  onFlip: (enabled: boolean) => void;
}) => {
  const [busy, setBusy] = useState(false);
  const flip = () => {
    setBusy(true);
    setAgentSkill(agent, name, !enabled)
      .then((response) => {
        if (response.ok) {
          invalidateOrg();
          onFlip(!enabled);
        }
      })
      .finally(() => setBusy(false));
  };
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label={`${enabled ? "disable" : "enable"} the ${name} skill`}
      disabled={busy}
      onClick={(event) => {
        event.stopPropagation();
        flip();
      }}
      className={cn(
        "relative h-4 w-7 shrink-0 cursor-pointer rounded-full border transition-colors disabled:opacity-50",
        enabled ? "border-moss bg-moss/60" : "border-border bg-muted",
      )}
    >
      <span
        className={cn(
          "absolute top-1/2 size-3 -translate-y-1/2 rounded-full bg-background shadow transition-all",
          enabled ? "left-3.5" : "left-0.5",
        )}
      />
    </button>
  );
};

const TABS: ReadonlyArray<{ id: AgentTab; icon: typeof ScrollText }> = [
  { id: "charter", icon: ScrollText },
  { id: "skills", icon: Blocks },
  { id: "tools", icon: Wrench },
];

export const AgentProfile = ({
  name,
  tab,
  item,
  onUp,
  chat,
}: {
  name: string;
  /** `chat` when this surface IS the DM (`/c/:slug`) — same header,
   *  same tabs, the feed as the body. */
  tab: AgentTab | "chat";
  /** The selected card on the tab — a skill or tool name. */
  item?: string;
  onUp: () => void;
  /** The agent's DM feed — the Chat tab's body. */
  chat?: React.ReactNode;
}) => {
  const [org, setOrg] = useState<OrgGraph | undefined>();
  useEffect(() => {
    let alive = true;
    fetchOrg()
      .then((graph) => {
        if (alive) setOrg(graph);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [name]);

  const agent = org?.agents.find(
    (candidate) =>
      candidate.name.toLowerCase() === name.toLowerCase() ||
      candidate.slug === name.toLowerCase(),
  );

  return (
    <section
      data-column="feed"
      aria-label={`agent profile ${name}`}
      className="flex min-h-0 min-w-0 flex-1 flex-col"
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5">
        <button
          type="button"
          onClick={onUp}
          aria-label="back to the channel"
          className="flex size-6 cursor-pointer items-center justify-center rounded hover:bg-accent"
        >
          <ArrowLeft className="size-3.5" />
        </button>
        <span className="font-mono text-xs text-muted-foreground">
          {agent?.groups.map((group) => (
            <span key={group}>
              {group}
              <ChevronRight className="mx-0.5 inline size-3" />
            </span>
          ))}
          {agent?.slug ?? name}
        </span>
      </header>
      {agent === undefined ? (
        chat !== undefined ? (
          // the DM must not wait on the org fetch — the feed stands
          // alone until the identity header can render
          <div className="flex min-h-0 flex-1 flex-col">{chat}</div>
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            {org === undefined ? "loading the org…" : `no agent named ${name}`}
          </div>
        )
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          {/* identity: who this is, on what, declared where */}
          <div className="flex shrink-0 flex-wrap items-center gap-3 p-4 pb-3">
            <Avatar name={agent.slug} kind="agent" size={44} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-lg font-semibold">{agent.slug}</span>
                <KindBadge kind="agent" />
              </div>
              <div className="mt-0.5 flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
                {agent.model !== undefined && (
                  <span className="inline-flex items-center gap-1">
                    <Cpu className="size-3" />
                    {agent.model.label}
                  </span>
                )}
                {agent.source !== undefined && (
                  <span className="inline-flex items-center gap-1 font-mono">
                    <FileCode2 className="size-3" />
                    {agent.source}
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* the tabs — ONE header for both surfaces: Chat is the DM
              (`/c/:slug`), the rest are the profile's sections
              (`/a/:name/:tab/:item`) */}
          <nav
            aria-label="profile sections"
            className="flex shrink-0 items-center gap-1 border-b border-border px-4"
          >
            <button
              type="button"
              aria-current={tab === "chat" ? "page" : undefined}
              onClick={() => showChannel(agent.slug)}
              className={cn(
                "flex cursor-pointer items-center gap-1.5 border-b-2 px-2.5 py-1.5 text-xs",
                tab === "chat"
                  ? "border-primary font-semibold text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              <MessageCircle className="size-3.5" />
              Chat
            </button>
            {TABS.map(({ id, icon: Icon }) => (
              <button
                key={id}
                type="button"
                aria-current={tab === id ? "page" : undefined}
                onClick={() => showAgent(agent.name, id)}
                className={cn(
                  "flex cursor-pointer items-center gap-1.5 border-b-2 px-2.5 py-1.5 text-xs capitalize",
                  tab === id
                    ? "border-primary font-semibold text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                <Icon className="size-3.5" />
                {id}
                {id === "skills" && agent.skills.length > 0 && (
                  <span className="text-[10px] text-muted-foreground">
                    {agent.skills.length}
                  </span>
                )}
                {id === "tools" && (
                  <span className="text-[10px] text-muted-foreground">
                    {agent.tools.length}
                  </span>
                )}
              </button>
            ))}
          </nav>

          {tab === "chat" ? (
            /* the DM feed — it owns its scroll and composer */
            <div className="flex min-h-0 flex-1 flex-col">{chat}</div>
          ) : (
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-8">
            {tab === "charter" && (
              /* the charter — the same prose the model reads, laid
                 out as a DOCUMENT */
              <article className={DOC}>
                <MarkdownText text={agent.charter} />
              </article>
            )}

            {tab === "skills" &&
              (agent.skills.length === 0 ? (
                <div className="py-10 text-center text-sm text-muted-foreground">
                  no skills granted to this agent
                </div>
              ) : (
                /* skills — a document LIST: collapsed rows, the
                   teaching on expand; the switch rides the header */
                <article className="w-full max-w-2xl divide-y divide-border/40">
                  {agent.skills.map((grant) => (
                    <DocRow
                      key={grant.name}
                      selected={item === grant.name}
                      icon={Blocks}
                      name={grant.name}
                      extras={
                        <>
                          {!grant.enabled && (
                            <span className="shrink-0 text-[10px] text-muted-foreground">
                              off — activation refused
                            </span>
                          )}
                          <SkillSwitch
                            agent={agent.name}
                            name={grant.name}
                            enabled={grant.enabled}
                            onFlip={(enabled) =>
                              setOrg((current) =>
                                current === undefined
                                  ? current
                                  : {
                                      ...current,
                                      agents: current.agents.map((candidate) =>
                                        candidate.name === agent.name
                                          ? {
                                              ...candidate,
                                              skills: candidate.skills.map(
                                                (entry) =>
                                                  entry.name === grant.name
                                                    ? { ...entry, enabled }
                                                    : entry,
                                              ),
                                            }
                                          : candidate,
                                      ),
                                    },
                              )
                            }
                          />
                        </>
                      }
                    >
                      <div className={PROSE}>
                        <MarkdownText
                          text={
                            org?.skills.find(
                              (skill) => skill.name === grant.name,
                            )?.teaching ?? ""
                          }
                        />
                      </div>
                    </DocRow>
                  ))}
                </article>
              ))}

            {tab === "tools" && (
              /* tools — a document LIST: collapsed rows, the prose
                 and schema pills on expand */
              <article className="w-full max-w-2xl divide-y divide-border/40">
                {agent.tools.map((tool) => (
                  <DocRow
                    key={tool.name}
                    selected={item === tool.name}
                    icon={Wrench}
                    name={tool.name}
                    extras={
                      <span className="shrink-0 rounded-full border border-border/60 px-1.5 py-px text-[10px] text-muted-foreground">
                        {tool.kind === "static" ? "tool" : "contract"}
                      </span>
                    }
                  >
                    <div className={PROSE}>
                      <MarkdownText text={tool.description} />
                    </div>
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {tool.params.map((param) => (
                        <Pill key={`in-${param}`} tone="muted" title="a parameter">
                          {param}
                        </Pill>
                      ))}
                      {tool.outputs.map((output) => (
                        <Pill
                          key={`out-${output}`}
                          tone="amber"
                          title="an answer field"
                        >
                          → {output}
                        </Pill>
                      ))}
                      {tool.errors.map((error) => (
                        <Pill
                          key={`err-${error}`}
                          tone="red"
                          title="a declared failure"
                        >
                          {error}
                        </Pill>
                      ))}
                    </div>
                  </DocRow>
                ))}
              </article>
            )}
          </div>
          )}
        </div>
      )}
    </section>
  );
};
