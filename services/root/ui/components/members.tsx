/**
 * WHO is in the channel — discord's member list, for an org where
 * members are humans AND agents. The roster is STATIC — the org
 * chart is code, so every agent in a channel is declared, identity
 * fixed. An agent may hold many sessions (the engineer works each
 * thread in its own), but it is one member. Clicking an agent opens
 * its standing session.
 */
import { Avatar, HUMAN, type Author } from "@/components/avatar";
import { showAgent } from "@/lib/routes";
import { cn } from "@/lib/utils";

interface Member extends Author {
  /** The session the member holds (agents only) — the row itself
   *  opens the agent's PROFILE (`/a/:name`), the org's mirror page. */
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
              : () => showAgent(member.name)
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
  const humans: Array<Member> = [
    { ...HUMAN, online: true, detail: "owner — you" },
  ];

  const agents: Array<Member> =
    channel === "engineering"
      ? [
          {
            name: "manager",
            kind: "agent",
            online: true,
            session: "Manager:root::manager",
            detail: "runs this channel",
          },
          {
            name: "engineer",
            kind: "agent",
            online: true,
            session: "Engineer:root::engineer",
            detail: "the worker — a session per thread",
          },
          {
            name: "reviewer",
            kind: "agent",
            online: true,
            session: "Reviewer:root::reviewer",
            detail: "the quality gate",
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

  return (
    <aside
      aria-label="channel members"
      className="flex w-52 shrink-0 flex-col overflow-y-auto border-l border-border bg-muted/20 pb-3 max-lg:hidden"
    >
      <Section label="humans" members={humans} />
      <Section label="agents" members={agents} />
    </aside>
  );
};
