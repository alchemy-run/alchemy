/**
 * An AGENT's PROFILE — the mirror of its declaration (`/a/:name`).
 *
 * The org is type-safe code; deploying it produces this page: the
 * charter prose (the same text the model reads), the pinned model,
 * the granted tools with their schema summaries and PERMISSION pills
 * (the attributed binding acquisitions), the skills with their
 * runtime switches (the gate the driver consults), and the group
 * membership trail. Editing the page IS editing the code — except
 * the skill switches, the one runtime dial.
 */
import { Avatar, KindBadge } from "@/components/avatar";
import { MarkdownText } from "@/components/chat";
import {
  fetchOrg,
  setAgentSkill,
  type OrgAgent,
  type OrgGraph,
  type OrgTool,
} from "@/lib/org";
import { showChannel, showOverlay } from "@/lib/routes";
import { cn } from "@/lib/utils";
import {
  ArrowLeft,
  Blocks,
  ChevronRight,
  Cpu,
  FileCode2,
  MessageSquare,
  ShieldCheck,
  Wrench,
} from "lucide-react";
import { useEffect, useState } from "react";

/** Where "Message" goes: channel agents open their channel; the
 *  others open their standing session's working pane. */
const message = (agent: OrgAgent): void => {
  if (agent.name === "Head") return showChannel("root");
  if (agent.name === "Manager") return showChannel("engineering");
  showOverlay({
    kind: "agent",
    id: `${agent.name}:root::${agent.slug}`,
  });
};

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

const ToolCard = ({ tool }: { tool: OrgTool }) => (
  <div className="flex flex-col gap-1.5 rounded-lg border border-border/70 bg-muted/10 p-3">
    <div className="flex flex-wrap items-center gap-2">
      <Wrench className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="font-mono text-xs font-semibold">{tool.name}</span>
      <Pill tone="muted">{tool.kind === "static" ? "tool" : "contract"}</Pill>
      {tool.permissions.map((permission) => (
        <Pill
          key={`${permission.binding}:${permission.targets.join(",")}`}
          tone="green"
          title={`${permission.binding} on ${permission.targets.join(", ") || "the account"}`}
        >
          <ShieldCheck className="size-2.5 shrink-0" />
          {permission.binding}
          {permission.targets.length > 0 && ` → ${permission.targets.join(", ")}`}
        </Pill>
      ))}
    </div>
    <div className="text-[12px] leading-relaxed text-muted-foreground">
      <MarkdownText text={tool.description} />
    </div>
    <div className="flex flex-wrap gap-1">
      {tool.params.map((param) => (
        <Pill key={`in-${param}`} tone="muted" title="a parameter">
          {param}
        </Pill>
      ))}
      {tool.outputs.map((output) => (
        <Pill key={`out-${output}`} tone="amber" title="an answer field">
          → {output}
        </Pill>
      ))}
      {tool.errors.map((error) => (
        <Pill key={`err-${error}`} tone="red" title="a declared failure">
          {error}
        </Pill>
      ))}
    </div>
  </div>
);

const SkillCard = ({
  agent,
  name,
  enabled,
  teaching,
  onFlip,
}: {
  agent: string;
  name: string;
  enabled: boolean;
  teaching: string | undefined;
  onFlip: (enabled: boolean) => void;
}) => {
  const [busy, setBusy] = useState(false);
  const flip = () => {
    setBusy(true);
    setAgentSkill(agent, name, !enabled)
      .then((response) => {
        if (response.ok) onFlip(!enabled);
      })
      .finally(() => setBusy(false));
  };
  return (
    <div
      className={cn(
        "flex flex-col gap-1.5 rounded-lg border p-3",
        enabled
          ? "border-border/70 bg-muted/10"
          : "border-border/40 bg-muted/5 opacity-70",
      )}
    >
      <div className="flex items-center gap-2">
        <Blocks className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-mono text-xs font-semibold">
          {name}
        </span>
        {/* the runtime switch — the gate the driver consults at
            activation (PATCH /api/org/agents/:agent/skills/:skill) */}
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label={`${enabled ? "disable" : "enable"} the ${name} skill`}
          disabled={busy}
          onClick={flip}
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
      </div>
      {teaching !== undefined && (
        <div className="max-h-24 overflow-hidden text-[11px] leading-relaxed text-muted-foreground [mask-image:linear-gradient(to_bottom,black_60%,transparent)]">
          <MarkdownText text={teaching} />
        </div>
      )}
      {!enabled && (
        <p className="text-[10px] text-muted-foreground">
          switched off — activation is refused until re-enabled
        </p>
      )}
    </div>
  );
};

export const AgentProfile = ({
  name,
  onUp,
}: {
  name: string;
  onUp: () => void;
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
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          {org === undefined ? "loading the org…" : `no agent named ${name}`}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-4">
          {/* identity: who this is, on what, declared where */}
          <div className="flex flex-wrap items-center gap-3">
            <Avatar name={agent.slug} kind="agent" size={44} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-lg font-semibold">{agent.slug}</span>
                <KindBadge kind="agent" />
              </div>
              <div className="mt-0.5 flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
                <span className="inline-flex items-center gap-1">
                  <Cpu className="size-3" />
                  {agent.model.label}
                </span>
                {agent.source !== undefined && (
                  <span className="inline-flex items-center gap-1 font-mono">
                    <FileCode2 className="size-3" />
                    {agent.source}
                  </span>
                )}
              </div>
            </div>
            <button
              type="button"
              onClick={() => message(agent)}
              className="flex cursor-pointer items-center gap-1.5 rounded-md border border-border/60 px-2.5 py-1 text-xs hover:bg-accent"
            >
              <MessageSquare className="size-3.5" />
              Message
            </button>
          </div>

          {/* the charter — the same prose the model reads */}
          <section aria-label="charter" className="flex flex-col gap-2">
            <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Charter
            </h2>
            <div className="rounded-lg border border-border/70 bg-muted/10 p-3 text-[13px]">
              <MarkdownText text={agent.charter} />
            </div>
          </section>

          {/* skills — granted in code, switched at runtime */}
          {agent.skills.length > 0 && (
            <section aria-label="skills" className="flex flex-col gap-2">
              <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Skills — {agent.skills.length}
              </h2>
              <div className="grid gap-2 md:grid-cols-2">
                {agent.skills.map((grant) => (
                  <SkillCard
                    key={grant.name}
                    agent={agent.name}
                    name={grant.name}
                    enabled={grant.enabled}
                    teaching={
                      org?.skills.find((skill) => skill.name === grant.name)
                        ?.teaching
                    }
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
                                      skills: candidate.skills.map((entry) =>
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
                ))}
              </div>
            </section>
          )}

          {/* tools — the capability envelope, permissions included */}
          <section aria-label="tools" className="flex flex-col gap-2">
            <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Tools — {agent.tools.length}
            </h2>
            <div className="grid gap-2 md:grid-cols-2">
              {agent.tools.map((tool) => (
                <ToolCard key={tool.name} tool={tool} />
              ))}
            </div>
          </section>
        </div>
      )}
    </section>
  );
};
