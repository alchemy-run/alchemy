/**
 * WHO is in the channel — discord's member list, for an org where
 * members are humans AND agents. The roster is the org chart (code),
 * not runtime state: the channel's resident agent is static, the
 * humans are the owners, and the engineers appear while the ledger
 * shows them on work. Clicking an agent opens its session.
 */
import { Avatar, HUMAN, type Author } from "@/components/avatar";
import { useTasks } from "@/components/tasks";
import { showOverlay } from "@/lib/routes";
import { cn } from "@/lib/utils";

interface Member extends Author {
  /** The session the member's row opens (agents only). */
  readonly session?: string;
  /** One line under the pointer — what they're on. */
  readonly detail?: string;
  readonly online: boolean;
}

const Section = ({
  label,
  members,
}: {
  label: string;
  members: ReadonlyArray<Member>;
}) => {
  if (members.length === 0) return null;
  return (
    <div className="flex flex-col gap-0.5">
      <div className="px-2 pt-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label} — {members.length}
      </div>
      {members.map((member) => (
        <button
          key={member.name}
          type="button"
          disabled={member.session === undefined}
          onClick={
            member.session === undefined
              ? undefined
              : () => showOverlay({ kind: "agent", id: member.session! })
          }
          title={member.detail ?? member.name}
          className={cn(
            "flex items-center gap-2 rounded-md px-2 py-1 text-left",
            member.session !== undefined &&
              "cursor-pointer hover:bg-accent/70",
          )}
        >
          <div className="relative">
            <Avatar name={member.name} kind={member.kind} size={28} />
            <span
              className={cn(
                "absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full border-2 border-background",
                member.online ? "bg-moss" : "bg-muted-foreground/40",
              )}
            />
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px]">{member.name}</div>
            {member.detail !== undefined && (
              <div className="truncate text-[10px] text-muted-foreground">
                {member.detail}
              </div>
            )}
          </div>
        </button>
      ))}
    </div>
  );
};

export const MembersPanel = ({ channel }: { channel: string }) => {
  const tasks = useTasks();

  const humans: Array<Member> = [
    { ...HUMAN, online: true, detail: "owner — you" },
  ];

  const agents: Array<Member> =
    channel === "engineering"
      ? [
          {
            name: "engineering-manager",
            kind: "agent",
            online: true,
            session: "EngineeringManager:root::engineering-manager",
            detail: "runs this channel",
          },
        ]
      : channel === "product"
        ? [
            {
              name: "product-manager",
              kind: "agent",
              online: true,
              session: "ProductManager:root::product-manager",
              detail: "runs this channel",
            },
          ]
        : [
            {
              name: "head",
              kind: "agent",
              online: true,
              session: "Head:root",
              detail: "runs this channel",
            },
          ];

  // engineers surface while the ledger has them on work — done work
  // ages them out of the list, exactly like leaving the room
  const engineers: Array<Member> =
    channel === "engineering"
      ? [
          ...new Map(
            tasks
              .filter((task) => task.assignee !== undefined)
              .map((task) => [
                task.assignee!,
                {
                  name: task.assignee!,
                  kind: "agent" as const,
                  online: task.status === "working" || task.status === "review",
                  session: `Engineer:root::${task.assignee!}`,
                  detail: task.title,
                },
              ]),
          ).values(),
        ]
      : [];

  return (
    <aside
      aria-label="channel members"
      className="flex w-52 shrink-0 flex-col overflow-y-auto border-l border-border bg-muted/20 pb-3 max-lg:hidden"
    >
      <Section label="humans" members={humans} />
      <Section label="agents" members={agents} />
      <Section label="engineers" members={engineers} />
    </aside>
  );
};
