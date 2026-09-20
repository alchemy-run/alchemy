/**
 * The DESK VIEW (`/tasks/:queue/desks/:agent`) — one desk's standing
 * session with its CONTEXT CHAIN as a left rail (generation-rail):
 * the live tip renders the session's transcript; a selected
 * generation renders its distilled doc (the observation log the
 * compaction wrote). "branch @N" seeds a NEW session from that
 * generation (`POST /api/sessions/branch` → Sessions.branch) and
 * opens it as a pane; a driver that cannot branch (the Cloudflare
 * DO driver, 501) disables the button with the reason.
 */
import { Avatar, KindBadge } from "@/components/avatar";
import { ChatView, MarkdownText, timeAgo } from "@/components/chat";
import {
  GenerationRail,
  type GenerationNode,
} from "@/components/generation-rail";
import { useQueues, WidthStepper } from "@/components/task-board";
import { deskSessionId } from "@/lib/tasks";
import { openPane, showAgent, showTasks } from "@/lib/routes";
import { cn } from "@/lib/utils";
import { ArrowLeft, Brain, GitBranch, Loader2, Radio } from "lucide-react";
import { useEffect, useState } from "react";

const PROSE =
  "text-[14px] leading-relaxed [&_p]:my-2.5 [&_p:first-child]:mt-0 " +
  "[&_p:last-child]:mb-0 [&_ul]:my-2 [&_li]:my-0.5 [&_pre]:my-3";

/** The session's generation chain — the `compaction` rows of its
 *  observation log (`GET /api/chats/:id/log`), tip first. */
const useLineage = (
  session: string | undefined,
): ReadonlyArray<GenerationNode> | undefined => {
  const [lineage, setLineage] = useState<
    ReadonlyArray<GenerationNode> | undefined
  >();
  useEffect(() => {
    if (session === undefined) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () => {
      fetch(`/api/chats/${encodeURIComponent(session)}/log`)
        .then(async (response) => {
          if (!alive || !response.ok) return;
          const log = (await response.json()) as ReadonlyArray<{
            type: string;
            record?: GenerationNode;
          }>;
          const generations: Array<GenerationNode> = [];
          for (const row of log) {
            if (row.type === "compaction" && row.record !== undefined) {
              generations.unshift(row.record);
            }
          }
          setLineage(generations);
          timer = setTimeout(load, 10_000);
        })
        .catch(() => {
          if (alive) timer = setTimeout(load, 15_000);
        });
    };
    load();
    return () => {
      alive = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [session]);
  return lineage;
};

/** The BRANCH button — a new session pane on success; the typed
 *  refusal (501 on the DO driver) disables it with the reason. */
const BranchButton = ({
  term,
  deskKey,
  node,
}: {
  term: string;
  deskKey: string;
  node: GenerationNode;
}) => {
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | undefined>();
  const branch = () => {
    setBusy(true);
    const key = `${deskKey}::branch@${node.generation}-${Date.now().toString(36)}`;
    fetch("/api/sessions/branch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ref: node.ref, key }),
    })
      .then(async (response) => {
        if (response.ok) {
          const body = (await response.json()) as { session: string };
          openPane({ kind: "agent", id: `${term}:${body.session}` });
          return;
        }
        setRefused(
          response.status === 501
            ? "branching requires the local driver for now"
            : ((await response.json().catch(() => ({}))) as { error?: string })
                .error ?? "branch refused",
        );
      })
      .catch(() => setRefused("branch failed — is the server up?"))
      .finally(() => setBusy(false));
  };
  return (
    <span className="flex items-center gap-2">
      <button
        type="button"
        disabled={busy || refused !== undefined}
        onClick={branch}
        title={refused ?? `seed a new session from @${node.generation}`}
        className={cn(
          "flex cursor-pointer items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs hover:bg-accent",
          (busy || refused !== undefined) && "cursor-default opacity-50",
        )}
      >
        {busy ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          <GitBranch className="size-3.5" />
        )}
        branch @{node.generation}
      </button>
      {refused !== undefined && (
        <span className="text-[11px] text-muted-foreground">{refused}</span>
      )}
    </span>
  );
};

export const DeskView = ({
  queue,
  agent,
}: {
  queue: string;
  agent: string;
}) => {
  const queues = useQueues(true);
  const view = queues?.find((candidate) => candidate.slug === queue);
  const desk = view?.desks.find((candidate) => candidate.slug === agent);
  const session = desk === undefined ? undefined : deskSessionId(desk);
  const lineage = useLineage(session);
  /** The open node — "live" (the tip's transcript) or a ref. */
  const [selected, setSelected] = useState<string>("live");
  const node = lineage?.find((candidate) => candidate.ref === selected);

  if (queues !== undefined && (view === undefined || desk === undefined)) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        no desk {agent} in the {queue} stream
      </div>
    );
  }
  if (desk === undefined || session === undefined || view === undefined) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        loading the desk…
      </div>
    );
  }

  return (
    <section
      aria-label={`desk ${queue}/${agent}`}
      className="flex min-h-0 min-w-0 flex-1 flex-col"
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5">
        <button
          type="button"
          onClick={() => showTasks(queue)}
          aria-label="back to the board"
          className="flex size-6 cursor-pointer items-center justify-center rounded hover:bg-accent"
        >
          <ArrowLeft className="size-3.5" />
        </button>
        <Avatar name={desk.slug} kind="agent" size={20} />
        <span className="font-mono text-xs font-semibold">{desk.slug}</span>
        <KindBadge kind="agent" />
        <span
          className="text-xs text-muted-foreground"
          title={`${desk.slug}'s standing seat at the ${view.name} queue — every task this queue assigns ${desk.slug} runs through this one long-lived thread, so its context carries from task to task`}
        >
          {view.name} desk
        </span>
        {desk.working.length > 0 && (
          <span className="flex items-center gap-1 text-[11px] text-primary/80">
            <Loader2 className="size-3 shrink-0 animate-spin" />
            working {desk.working.map((work) => work.id).join(", ")}
          </span>
        )}
        <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
          width
          <WidthStepper queue={queue} desk={desk.slug} width={desk.width} />
        </span>
        <button
          type="button"
          onClick={() => showAgent(desk.term, "self")}
          title="the identity's self digest — what this agent has learned"
          className="ml-auto flex cursor-pointer items-center gap-1.5 rounded-md border border-border/60 px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <Brain className="size-3" />
          self digest
        </button>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* the context chain — the rail */}
        <nav
          aria-label="context chain"
          className="flex w-52 shrink-0 flex-col overflow-y-auto border-r border-border bg-muted/20 p-2"
        >
          <div className="px-2 pb-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            memory
          </div>
          <p className="px-2 pb-2 text-[10.5px] leading-snug text-muted-foreground/80">
            one thread works every task here; when it grows too long
            it is folded into notes. Newest first — click a fold to
            read what the notes kept.
          </p>
          <button
            type="button"
            aria-current={selected === "live" ? "true" : undefined}
            onClick={() => setSelected("live")}
            className={cn(
              "flex w-full cursor-pointer flex-col gap-0.5 rounded-md px-2 py-1.5 text-left",
              selected === "live" ? "bg-accent font-medium" : "hover:bg-accent/60",
            )}
          >
            <span className="flex items-center gap-1.5">
              <Radio className="size-3 shrink-0 text-moss" />
              <span className="text-[11.5px]">live transcript</span>
            </span>
            <span className="pl-[18px] text-[10px] text-muted-foreground">
              what the desk sees now
            </span>
          </button>
          {/* active CLONES — extra width slots forked from the trunk;
              each opens its clone session as a pane */}
          {desk.working
            .filter((work) => work.session !== desk.deskKey)
            .map((work) => (
              <button
                key={work.session}
                type="button"
                onClick={() =>
                  openPane({ kind: "agent", id: `${desk.term}:${work.session}` })
                }
                title={`open the clone session working ${work.id}`}
                className="flex w-full cursor-pointer items-center gap-1.5 rounded-md py-1 pl-[26px] pr-2 text-left font-mono text-[10.5px] text-muted-foreground hover:bg-accent/60"
              >
                <GitBranch className="size-3 shrink-0" />
                clone #{work.session.slice(work.session.lastIndexOf("#") + 1)} ·{" "}
                {work.id}
              </button>
            ))}
          {lineage === undefined ? (
            <div className="px-2 py-4 text-[11px] text-muted-foreground">
              loading the chain…
            </div>
          ) : (
            <GenerationRail
              generations={lineage}
              selected={selected}
              onSelect={setSelected}
            />
          )}
        </nav>

        {/* the open node: the live transcript, or a generation's doc */}
        {selected === "live" || node === undefined ? (
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <ChatView id={session} active={false} readOnly flat />
          </div>
        ) : (
          <div className="min-h-0 min-w-0 flex-1 overflow-y-auto px-6 py-5">
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <span className="font-mono text-[12px] font-medium">
                {node.ref}
              </span>
              <span className="rounded-full border border-border/60 px-1.5 py-px font-mono text-[10px] text-muted-foreground">
                {node.kind} · {node.author}
              </span>
              <span className="font-mono text-[10.5px] text-muted-foreground">
                {node.tokensBefore.toLocaleString()} →{" "}
                {node.tokensAfter.toLocaleString()} tokens ·{" "}
                {node.dropped} messages folded away · {timeAgo(node.at)}
              </span>
              <BranchButton term={desk.term} deskKey={desk.deskKey} node={node} />
            </div>
            {node.doc === undefined || node.doc.length === 0 ? (
              <div className="py-6 text-sm text-muted-foreground">
                this generation carries no doc — a bare{" "}
                <span className="font-mono">{node.kind}</span>
              </div>
            ) : (
              <article className={cn("w-full max-w-2xl", PROSE)}>
                <MarkdownText text={node.doc} />
              </article>
            )}
          </div>
        )}
      </div>
    </section>
  );
};
