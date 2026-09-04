import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { Bell, ExternalLink, Moon, Sun, User } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

/** The brand mark — the alchemy yantra: a circle, a triangle, the
 *  bindu. Strokes follow the text color; the dot is terracotta. */
export const AlchemyMark = ({ className }: { className?: string }) => (
  <svg
    viewBox="1.8 1.8 20.4 20.4"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.4"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
    className={className}
  >
    <circle cx="12" cy="12" r="9.5" />
    <path d="M12 21.15 L4.0759 7.425 L19.9241 7.425 Z" />
    <circle cx="12" cy="12" r="1.1" className="fill-terracotta" stroke="none" />
  </svg>
);

/** Who the org acts as on GitHub — `GET /api/me`; `null` when the
 *  placement has no token (or GitHub is unreachable). */
export interface Operator {
  login: string;
  name: string | null;
  avatarUrl: string;
  url: string;
}

const useOperator = (): Operator | null | undefined => {
  const [operator, setOperator] = useState<Operator | null | undefined>(
    undefined,
  );
  useEffect(() => {
    let live = true;
    fetch("/api/me")
      .then((response) =>
        response.ok ? (response.json() as Promise<Operator | null>) : null,
      )
      .then((value) => {
        if (live) setOperator(value);
      })
      .catch(() => {
        if (live) setOperator(null);
      });
    return () => {
      live = false;
    };
  }, []);
  return operator;
};

/**
 * The app bar: the mark and the two activities on the left; on the
 * right, the notification bell (the proposals awaiting the operator —
 * `notifications` renders its contents), the theme, and the operator.
 */
export const AppHeader = ({
  activity,
  onActivity,
  openPullRequests,
  pending,
  notifications,
  notificationsOpen,
  onNotificationsOpen,
}: {
  activity: "code" | "review";
  onActivity: (activity: "code" | "review") => void;
  /** Open pull requests — the count on the Review activity. */
  openPullRequests: number;
  /** Proposals awaiting the operator — the count on the bell. */
  pending: number;
  notifications: ReactNode;
  notificationsOpen: boolean;
  onNotificationsOpen: (open: boolean) => void;
}) => {
  const { resolved, toggle } = useTheme();
  const operator = useOperator();
  const ThemeIcon = resolved === "dark" ? Moon : Sun;

  return (
    <header className="flex h-12 shrink-0 items-center gap-4 border-b border-border bg-sidebar px-3">
      <a
        href="#"
        onClick={(event) => {
          event.preventDefault();
          onActivity("code");
        }}
        className="flex items-center gap-2 text-foreground"
        title="Alchemy"
      >
        <AlchemyMark className="size-5" />
        <span className="text-sm font-semibold tracking-tight">Alchemy</span>
      </a>
      <nav aria-label="Activities" className="flex items-center gap-1">
        {(["code", "review"] as const).map((name) => {
          const selected = activity === name;
          return (
            <button
              key={name}
              type="button"
              aria-current={selected ? "page" : undefined}
              title={
                name === "code"
                  ? "Code — sessions on your own directories: agent threads and terminals, no pull request needed."
                  : `Review — the open pull requests${openPullRequests > 0 ? ` (${openPullRequests})` : ""}: read them, have the bot review them, work on their machines.`
              }
              onClick={() => onActivity(name)}
              className={cn(
                "flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-sm",
                // the selected activity is a LIFTED segment — card on the
                // nav surface with a hairline and a shadow — which reads
                // in both modes (accent-on-sidebar vanishes on parchment)
                selected
                  ? "border-border bg-card font-medium text-foreground shadow-xs"
                  : "border-transparent text-muted-foreground hover:bg-accent/60 hover:text-foreground",
              )}
            >
              {name === "code" ? "Code" : "Review"}
              {name === "review" && openPullRequests > 0 && (
                <Badge
                  variant="secondary"
                  className="h-5 min-w-5 justify-center bg-muted px-1.5 font-mono text-[10px] tabular-nums text-muted-foreground"
                >
                  {openPullRequests}
                </Badge>
              )}
            </button>
          );
        })}
      </nav>
      <div className="ml-auto flex items-center gap-1">
        <Popover open={notificationsOpen} onOpenChange={onNotificationsOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label={
                pending === 0
                  ? "notifications"
                  : `notifications, ${pending} awaiting you`
              }
              title={
                pending === 0
                  ? "Notifications — proposals from the agents land here; nothing awaits you."
                  : `Notifications — ${pending} proposal${pending === 1 ? "" : "s"} awaiting your accept or decline.`
              }
              className="relative size-8 text-muted-foreground hover:text-foreground"
            >
              <Bell className="size-4" />
              {pending > 0 && (
                <span
                  aria-hidden
                  className="absolute -right-1 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 font-mono text-[10px] font-medium tabular-nums text-primary-foreground"
                >
                  {pending}
                </span>
              )}
            </Button>
          </PopoverTrigger>
          <PopoverContent
            align="end"
            sideOffset={8}
            aria-label="proposals"
            className="flex max-h-[70vh] w-[26rem] flex-col overflow-hidden p-0"
          >
            {notifications}
          </PopoverContent>
        </Popover>
        <Button
          variant="ghost"
          size="icon"
          aria-label={
            resolved === "dark" ? "switch to light mode" : "switch to dark mode"
          }
          aria-pressed={resolved === "dark"}
          title={
            resolved === "dark"
              ? "Switch to light mode — the pick is remembered on this browser."
              : "Switch to dark mode — the pick is remembered on this browser."
          }
          onClick={toggle}
          className="size-8 text-muted-foreground hover:text-foreground"
        >
          <ThemeIcon className="size-4" />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={
                operator === null || operator === undefined
                  ? "account"
                  : `account, ${operator.login}`
              }
              title={
                operator === null || operator === undefined
                  ? "Account — the GitHub identity this deploy acts as."
                  : `Account — signed in to GitHub as @${operator.login}.`
              }
              className="ml-1 rounded-full outline-hidden ring-ring focus-visible:ring-2"
            >
              <Avatar className="size-7 border border-border">
                {operator !== null && operator !== undefined && (
                  <AvatarImage src={operator.avatarUrl} alt="" />
                )}
                <AvatarFallback className="text-muted-foreground">
                  <User className="size-3.5" />
                </AvatarFallback>
              </Avatar>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            {operator !== null && operator !== undefined ? (
              <>
                <DropdownMenuLabel className="flex flex-col gap-0.5">
                  <span className="text-sm font-medium">
                    {operator.name ?? operator.login}
                  </span>
                  <span className="font-mono text-[11px] text-muted-foreground">
                    @{operator.login}
                  </span>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <a href={operator.url} target="_blank" rel="noreferrer">
                    <ExternalLink className="size-4" />
                    GitHub profile
                  </a>
                </DropdownMenuItem>
              </>
            ) : (
              <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
                {operator === undefined
                  ? "Looking up the operator…"
                  : "No GitHub identity on this placement."}
              </DropdownMenuLabel>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <a href="https://alchemy.run" target="_blank" rel="noreferrer">
                <AlchemyMark className="size-4" />
                alchemy.run
              </a>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
};
