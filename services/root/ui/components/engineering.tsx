/**
 * The ENGINEERING pane — the manager AT WORK, visible.
 *
 * Top: the manager's LIVE FEED — its actual session transcript
 * (readOnly ChatView over `EngineeringManager:root::engineering-manager`),
 * streaming as inbound lines arrive and rounds file them. Below: the
 * TASK LEDGER as the manager moves it (todo → working → review → done;
 * assignee opens the engineer's session, workspace opens its terminal)
 * and the PROPOSALS awaiting the humans' click.
 */
import { ChatView } from "@/components/chat";
import { showOverlay } from "@/lib/routes";
import { cn } from "@/lib/utils";
import { Check, SquareTerminal, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

/** The manager's session id — the feed's wire. */
export const MANAGER_CHAT = "EngineeringManager:root::engineering-manager";

interface TaskItem {
  readonly ref: string;
  readonly kind: "issue" | "pull" | "request";
}

interface Task {
  readonly id: string;
  readonly title: string;
  readonly items: ReadonlyArray<TaskItem>;
  readonly status: "todo" | "working" | "review" | "done";
  readonly assignee?: string;
  readonly workspace?: string;
  readonly notes: ReadonlyArray<string>;
  readonly updatedAt: number;
}

interface Proposal {
  readonly id: string;
  readonly kind: string;
  readonly status: string;
  readonly summary: string;
  readonly detail: string;
}

const STATUSES = ["todo", "working", "review", "done"] as const;

const STATUS_DOT: Record<Task["status"], string> = {
  todo: "bg-muted-foreground/40",
  working: "bg-amber-500",
  review: "bg-sky-500",
  done: "bg-moss",
};

const TaskRow = ({ task }: { task: Task }) => (
  <div
    data-task={task.id}
    className="flex flex-col gap-0.5 rounded-md border border-border/60 px-2 py-1"
  >
    <div className="flex min-w-0 items-center gap-1.5">
      <span
        className={cn("size-1.5 shrink-0 rounded-full", STATUS_DOT[task.status])}
      />
      <span className="min-w-0 flex-1 truncate text-[12px]" title={task.title}>
        {task.title}
      </span>
    </div>
    <div className="flex flex-wrap items-center gap-1 pl-3 text-[10px] text-muted-foreground">
      {task.items.map((item) => (
        <a
          key={item.ref}
          href={`https://github.com/${item.ref.replace("#", "/issues/")}`}
          target="_blank"
          rel="noreferrer"
          className="font-mono hover:text-foreground hover:underline"
        >
          {item.ref.split("/").pop()}
        </a>
      ))}
      {task.assignee !== undefined && (
        <button
          type="button"
          onClick={() =>
            showOverlay({
              kind: "agent",
              id: `Engineer:root::${task.assignee}`,
            })
          }
          title={`open ${task.assignee}'s session`}
          className="cursor-pointer rounded border border-border/60 px-1 font-mono hover:bg-accent"
        >
          {task.assignee}
        </button>
      )}
      {task.workspace !== undefined && (
        <button
          type="button"
          onClick={() =>
            showOverlay({ kind: "workspace", name: task.workspace! })
          }
          title={`terminal into workspace ${task.workspace}`}
          className="flex cursor-pointer items-center gap-0.5 rounded border border-border/60 px-1 font-mono hover:bg-accent"
        >
          <SquareTerminal className="size-2.5" />
          {task.workspace}
        </button>
      )}
    </div>
  </div>
);

export const EngineeringPane = ({ active }: { active: boolean }) => {
  const [tasks, setTasks] = useState<ReadonlyArray<Task>>([]);
  const [proposals, setProposals] = useState<ReadonlyArray<Proposal>>([]);
  const [deciding, setDeciding] = useState<string | undefined>(undefined);

  const load = useCallback(() => {
    fetch("/api/tasks")
      .then(async (response) => {
        if (response.ok) {
          setTasks(((await response.json()) as { tasks: Task[] }).tasks);
        }
      })
      .catch(() => {});
    fetch("/api/proposals?status=pending")
      .then(async (response) => {
        if (response.ok) {
          setProposals(
            ((await response.json()) as { proposals: Proposal[] }).proposals,
          );
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, 5_000);
    return () => clearInterval(timer);
  }, [load]);

  const decide = (id: string, decision: "approve" | "deny") => {
    setDeciding(id);
    fetch(`/api/proposals/${encodeURIComponent(id)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision }),
    })
      .then(load)
      .finally(() => setDeciding(undefined));
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* the manager, live — its own words as it works */}
      <div className="flex items-center justify-between border-b border-border px-2 py-1">
        <span className="text-[11px] font-medium">engineering-manager</span>
        <button
          type="button"
          onClick={() => showOverlay({ kind: "agent", id: MANAGER_CHAT })}
          className="cursor-pointer rounded border border-border/60 px-1.5 text-[10px] text-muted-foreground hover:bg-accent"
        >
          full session
        </button>
      </div>
      <div className="min-h-0 flex-[3] overflow-hidden">
        <ChatView id={MANAGER_CHAT} active={active} readOnly />
      </div>

      {/* the ledger, as the manager moves it */}
      <div
        data-pane="tasks"
        className="flex min-h-0 flex-[2] flex-col border-t border-border"
      >
        <div className="flex items-center gap-2 px-2 py-1 text-[11px]">
          <span className="font-medium">tasks</span>
          {STATUSES.map((status) => (
            <span key={status} className="text-muted-foreground">
              {status}{" "}
              <span className="text-foreground">
                {tasks.filter((task) => task.status === status).length}
              </span>
            </span>
          ))}
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-2 pb-2">
          {tasks.length === 0 && (
            <div className="px-1 text-[11px] text-muted-foreground">
              No tasks yet — release an inbound event and watch the manager
              file it.
            </div>
          )}
          {STATUSES.flatMap((status) =>
            tasks
              .filter((task) => task.status === status)
              .map((task) => <TaskRow key={task.id} task={task} />),
          )}
        </div>
      </div>

      {/* the humans' queue — kept SMALL by policy */}
      <div
        data-pane="proposals"
        className="flex max-h-[30%] min-h-0 flex-col border-t border-border"
      >
        <div className="px-2 py-1 text-[11px] font-medium">
          proposals{" "}
          <span className="text-muted-foreground">
            {proposals.length} pending
          </span>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-2 pb-2">
          {proposals.length === 0 && (
            <div className="px-1 text-[11px] text-muted-foreground">
              Nothing awaits you.
            </div>
          )}
          {proposals.map((proposal) => (
            <div
              key={proposal.id}
              data-proposal={proposal.id}
              className="flex items-center gap-2 rounded-md border border-border/60 px-2 py-1"
            >
              <span
                className="min-w-0 flex-1 truncate text-[12px]"
                title={proposal.detail}
              >
                <span className="mr-1 rounded bg-muted px-1 font-mono text-[10px] text-muted-foreground">
                  {proposal.kind}
                </span>
                {proposal.summary}
              </span>
              <button
                type="button"
                onClick={() => decide(proposal.id, "approve")}
                disabled={deciding !== undefined}
                aria-label={`approve ${proposal.summary}`}
                className="flex size-5 cursor-pointer items-center justify-center rounded border border-border text-moss hover:bg-accent disabled:opacity-50"
              >
                <Check className="size-3" />
              </button>
              <button
                type="button"
                onClick={() => decide(proposal.id, "deny")}
                disabled={deciding !== undefined}
                aria-label={`deny ${proposal.summary}`}
                className="flex size-5 cursor-pointer items-center justify-center rounded border border-border text-destructive hover:bg-accent disabled:opacity-50"
              >
                <X className="size-3" />
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
