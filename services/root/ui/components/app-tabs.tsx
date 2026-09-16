/**
 * The APP's TOP TABS — Chat | Code | Issues | Pulls.
 *
 * The thesis, as chrome: the org is one thing seen four ways — the
 * conversation (Chat), the repositories it works on (Code), the work
 * it tracks (Issues), and the changes it proposes (Pulls). Chat
 * keeps its place across hops (rememberChatPath).
 */
import {
  rememberChatPath,
  showChat,
  showCode,
  showWork,
  type AppTab,
} from "@/lib/routes";
import { cn } from "@/lib/utils";
import {
  CircleDot,
  FolderGit2,
  GitPullRequest,
  MessageCircle,
} from "lucide-react";

const TABS: ReadonlyArray<{
  id: AppTab;
  label: string;
  icon: typeof MessageCircle;
}> = [
  { id: "chat", label: "Chat", icon: MessageCircle },
  { id: "code", label: "Code", icon: FolderGit2 },
  { id: "issues", label: "Issues", icon: CircleDot },
  { id: "pulls", label: "Pulls", icon: GitPullRequest },
];

export const AppTabs = ({ tab }: { tab: AppTab }) => {
  const open = (target: AppTab) => {
    if (target === tab) return;
    if (tab === "chat") rememberChatPath();
    if (target === "chat") showChat();
    else if (target === "code") showCode();
    else showWork(target);
  };
  return (
    <nav
      aria-label="app sections"
      className="flex shrink-0 items-center gap-1 border-b border-border bg-background px-3 py-1"
    >
      <span className="mr-3 text-sm font-semibold">root</span>
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
