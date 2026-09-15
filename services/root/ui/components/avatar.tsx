/**
 * WHO is speaking — identity for the channel's discord-shaped rows
 * and the members panel. Every author (human, agent, or the world's
 * event feed) renders the same way: a deterministic avatar, a name,
 * and a kind badge for non-humans.
 *
 * Avatars are derived (name-hashed hue + initials) until real
 * identity arrives: {@link Avatar} takes an optional `src`, so a
 * logged-in human's picture slots in without touching call sites.
 */
import { cn } from "@/lib/utils";
import { Bot, Rss } from "lucide-react";

export type AuthorKind = "human" | "agent" | "world";

export interface Author {
  readonly name: string;
  readonly kind: AuthorKind;
}

/** The signed-in human. A placeholder until auth exists — the shape
 *  (name + optional avatar url) is what a session will provide. */
export const HUMAN: Author & { readonly avatar?: string } = {
  name: "sam",
  kind: "human",
};

/** FNV-1a over the name — a stable hue per author. */
const hueOf = (name: string): number => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < name.length; index++) {
    hash ^= name.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % 360;
};

const initialsOf = (name: string): string => {
  const words = name.split(/[\s_-]+/).filter(Boolean);
  if (words.length >= 2) return (words[0]![0]! + words[1]![0]!).toUpperCase();
  return name.slice(0, 2).toUpperCase();
};

export const Avatar = ({
  name,
  kind,
  src,
  size = 36,
  className,
}: Author & { src?: string; size?: number; className?: string }) => {
  const hue = hueOf(name);
  return src !== undefined ? (
    <img
      src={src}
      alt={name}
      width={size}
      height={size}
      className={cn("shrink-0 rounded-full object-cover", className)}
    />
  ) : (
    <div
      aria-hidden
      style={{
        width: size,
        height: size,
        fontSize: size * 0.34,
        background: `linear-gradient(135deg, hsl(${hue} 45% 32%), hsl(${(hue + 40) % 360} 50% 22%))`,
        color: `hsl(${hue} 70% 82%)`,
      }}
      className={cn(
        "flex shrink-0 select-none items-center justify-center rounded-full font-semibold",
        className,
      )}
    >
      {kind === "world" ? (
        <Rss style={{ width: size * 0.5, height: size * 0.5 }} />
      ) : (
        initialsOf(name)
      )}
    </div>
  );
};

/** The discord "APP" move: non-humans wear their kind next to the
 *  name, so a reader always knows who is people and who is code. */
export const KindBadge = ({ kind }: { kind: AuthorKind }) => {
  if (kind === "human") return null;
  return (
    <span
      className={cn(
        "flex items-center gap-0.5 rounded px-1 py-px text-[9px] font-semibold uppercase tracking-wide",
        kind === "agent"
          ? "bg-primary/15 text-primary"
          : "bg-muted text-muted-foreground",
      )}
    >
      {kind === "agent" && <Bot className="size-2.5" />}
      {kind === "agent" ? "agent" : "events"}
    </span>
  );
};

/** A colleague NAME's session id — the UI's mirror of the server's
 *  Colleagues resolution, for digging into a live tree node. */
export const sessionOf = (name: string): string | undefined => {
  const slug = name.trim().toLowerCase();
  if (slug === "head") return "Head:root";
  if (slug === "manager") return "Manager:root::manager";
  if (slug === "reviewer") return "Reviewer:root::reviewer";
  if (/^e-[a-z0-9]+$/.test(slug)) return `Engineer:root::${slug}`;
  if (/^r-[a-z0-9]+$/.test(slug)) return `Reviewer:root::${slug}`;
  return undefined;
};

/** The author a SESSION's assistant rows speak as, from the chat id
 *  (`Head:root`, `Manager:root::manager`,
 *  `Engineer:root::e-4f2a`): the key's tail names the instance; the
 *  term names the singleton. */
export const sessionAuthor = (id: string): Author => {
  const colon = id.indexOf(":");
  const term = colon === -1 ? id : id.slice(0, colon);
  const key = colon === -1 ? "" : id.slice(colon + 1);
  const tail = key.split("::").filter(Boolean).pop();
  if (term === "Head") return { name: "head", kind: "agent" };
  if (tail !== undefined && tail !== "root") {
    return { name: tail, kind: "agent" };
  }
  // PascalCase term → kebab-case name
  return {
    name: term.replaceAll(/(?<=[a-z0-9])(?=[A-Z])/g, "-").toLowerCase(),
    kind: "agent",
  };
};
