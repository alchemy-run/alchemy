/**
 * The GENERATION RAIL — a session's context chain, one node per
 * compaction (`GenerationRecord`): the kind's glyph, the token
 * squeeze (`41k→8k`), and its age. Shared by the desk view's left
 * rail and the profile's Self tab; nodes select when `onSelect` is
 * given (the desk view opens the generation's doc).
 */
import { timeAgo } from "@/components/chat";
import { cn } from "@/lib/utils";
import {
  Brain,
  Eye,
  GitBranch,
  RotateCcw,
  Scissors,
  Sparkles,
} from "lucide-react";

/** One generation of a session's chain — the wire shape of the
 *  `compaction` observation's record (AI.GenerationRecord). */
export interface GenerationNode {
  /** The generation's address — `<term>/<key>@<n>`. */
  readonly ref: string;
  readonly generation: number;
  readonly parent: string | undefined;
  /** Who advanced it (`observational`, `charter`, `branch`). */
  readonly author: string;
  readonly kind: string;
  /** The distilled artifact this generation opens with. */
  readonly doc?: string;
  readonly dropped: number;
  readonly tokensBefore: number;
  readonly tokensAfter: number;
  readonly at: number;
}

const GLYPHS: Record<string, typeof Eye> = {
  observe: Eye,
  reflect: Brain,
  drop: Scissors,
  reset: RotateCcw,
  branch: GitBranch,
};

/** Plain-language names for what each compaction kind DID — the rail
 *  must read without knowing the engine's vocabulary. */
const LABELS: Record<string, string> = {
  observe: "folded into notes",
  reflect: "notes rewritten",
  drop: "trimmed",
  reset: "summarized",
  branch: "branched",
};

const tokens = (value: number): string =>
  value >= 1_000 ? `${(value / 1_000).toFixed(1)}k` : String(value);

/** One node of the rail. */
const RailNode = ({
  node,
  selected,
  onSelect,
}: {
  node: GenerationNode;
  selected: boolean;
  onSelect?: (ref: string) => void;
}) => {
  const Glyph = GLYPHS[node.kind] ?? Sparkles;
  const body = (
    <>
      <span className="flex items-center gap-1.5">
        <Glyph className="size-3 shrink-0 text-muted-foreground/70" />
        <span className="text-[11.5px]">
          {LABELS[node.kind] ?? node.kind}
        </span>
      </span>
      <span className="flex items-center gap-2 pl-[18px] font-mono text-[10px] text-muted-foreground">
        {tokens(node.tokensBefore)} → {tokens(node.tokensAfter)} tokens
        <span className="font-sans">{timeAgo(node.at)}</span>
      </span>
    </>
  );
  return onSelect === undefined ? (
    <div className="flex flex-col gap-0.5 rounded-md px-2 py-1.5">{body}</div>
  ) : (
    <button
      type="button"
      aria-current={selected ? "true" : undefined}
      onClick={() => onSelect(node.ref)}
      title={node.ref}
      className={cn(
        "flex w-full cursor-pointer flex-col gap-0.5 rounded-md px-2 py-1.5 text-left",
        selected
          ? "bg-accent font-medium"
          : "hover:bg-accent/60",
      )}
    >
      {body}
    </button>
  );
};

export const GenerationRail = ({
  generations,
  selected,
  onSelect,
  className,
}: {
  /** The chain, TIP FIRST (the order lineage/history answer it). */
  generations: ReadonlyArray<GenerationNode>;
  /** The selected node's ref — the desk view's open generation. */
  selected?: string;
  onSelect?: (ref: string) => void;
  className?: string;
}) =>
  generations.length === 0 ? (
    <div className={cn("px-2 py-4 text-[11px] text-muted-foreground", className)}>
      no compactions yet — still on the birth generation
    </div>
  ) : (
    <nav
      aria-label="generations"
      className={cn("flex flex-col gap-0.5", className)}
    >
      {generations.map((node) => (
        <RailNode
          key={node.ref}
          node={node}
          selected={node.ref === selected}
          {...(onSelect === undefined ? {} : { onSelect })}
        />
      ))}
    </nav>
  );
