/**
 * The APP's TOP TABS — Chat | Code | Issues | Pulls | Tasks.
 *
 * The thesis, as chrome: the org is one thing seen five ways — the
 * conversation (Chat), the repositories it works on (Code), the work
 * it tracks (Issues), the changes it proposes (Pulls), and the work
 * streams its desks pump through (Tasks). Chat keeps its place
 * across hops (rememberChatPath).
 */
import {
  rememberChatPath,
  showChat,
  showCode,
  showTasks,
  showWork,
  type AppTab,
} from "@/lib/routes";
import { cn } from "@/lib/utils";
import {
  CircleDot,
  FolderGit2,
  GitPullRequest,
  MessageCircle,
  SquareKanban,
} from "lucide-react";

/** The Alchemy brand mark — the Sri-Yantra water triangle in a ring
 *  with the bindu (geometry from website/src/brand/yantra.ts),
 *  stroked in currentColor so it rides the theme (white on dark). */
const Yantra = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 24 24" aria-hidden className={className}>
    <circle
      cx="12"
      cy="12"
      r="9.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.1"
    />
    <path
      d="M12 21.225 L4.0109 7.3875 L19.9891 7.3875 Z"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.1"
      strokeLinejoin="round"
    />
    <circle cx="12" cy="12" r="1.1" fill="currentColor" />
  </svg>
);

const TABS: ReadonlyArray<{
  id: AppTab;
  label: string;
  icon: typeof MessageCircle;
}> = [
  { id: "chat", label: "Chat", icon: MessageCircle },
  { id: "code", label: "Code", icon: FolderGit2 },
  { id: "issues", label: "Issues", icon: CircleDot },
  { id: "pulls", label: "Pulls", icon: GitPullRequest },
  { id: "tasks", label: "Tasks", icon: SquareKanban },
];

export const AppTabs = ({ tab }: { tab: AppTab }) => {
  const open = (target: AppTab) => {
    if (target === tab) return;
    if (tab === "chat") rememberChatPath();
    if (target === "chat") showChat();
    else if (target === "code") showCode();
    else if (target === "tasks") showTasks();
    else showWork(target);
  };
  return (
    <nav
      aria-label="app sections"
      className="flex shrink-0 items-center gap-1 border-b border-border bg-background px-3 py-1"
    >
      <span className="mr-3 flex items-center gap-2 text-sm font-semibold">
        <Yantra className="size-4 text-foreground" />
        Alchemy
      </span>
      {TABS.map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          type="button"
          aria-current={tab === id ? "page" : undefined}
          onClick={() => open(id)}
          className={cn(
            "flex cursor-pointer items-center gap-1.5 rounded-md px-2.5 py-1 text-xs",
            tab === id
              ? "bg-accent font-semibold text-foreground"
              : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
          )}
        >
          <Icon className="size-3.5" />
          {label}
        </button>
      ))}
    </nav>
  );
};
