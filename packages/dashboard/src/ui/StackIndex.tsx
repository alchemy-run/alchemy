import { ChevronRight, Layers } from "lucide-react";
import { useMemo, useState } from "react";
import { navigate, pathOf } from "../route.ts";
import type { StackEntry } from "../store.ts";
import { PANEL } from "../theme.ts";
import { Yantra } from "./Brand.tsx";

/**
 * The hosted viewer's landing page: every stack in the state store, with
 * its stages.
 *
 * Shown instead of guessing a target. The CLI dashboard never renders
 * this — it drives exactly one stack, so `/` goes straight to the graph.
 *
 * A stack with no stages is listed but inert: the store still registers
 * it, and pretending it isn't there would make the list disagree with
 * `/api/stacks`.
 */
export function StackIndex({ stacks }: { stacks: readonly StackEntry[] }) {
  const [filter, setFilter] = useState("");
  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const matches = needle
      ? stacks.filter(
          (s) =>
            s.stack.toLowerCase().includes(needle) ||
            s.stages.some((stage) => stage.toLowerCase().includes(needle)),
        )
      : stacks;
    return [...matches].sort((a, b) => a.stack.localeCompare(b.stack));
  }, [stacks, filter]);

  return (
    <main className="mx-auto min-h-dvh w-full max-w-3xl px-6 py-12">
      <header className="mb-8 flex items-center gap-3">
        <Yantra size={22} />
        <h1 className="font-serif text-[20px] font-medium tracking-[-0.01em] text-[var(--alc-fg-1)]">
          Stacks
        </h1>
        <span className="ml-auto font-mono text-[11px] text-[var(--alc-fg-4)]">
          {stacks.length === 1 ? "1 stack" : `${stacks.length} stacks`}
        </span>
      </header>

      {stacks.length > 6 && (
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter stacks and stages…"
          className="mb-4 w-full rounded-[var(--alc-radius-sm)] border border-[var(--alc-hairline-3)] bg-[var(--alc-bg-elev-1)] px-3 py-2 font-mono text-[12px] text-[var(--alc-fg-1)] placeholder:text-[var(--alc-fg-4)] focus:border-[var(--alc-fg-4)] focus:outline-none"
        />
      )}

      <ul className="flex flex-col gap-2">
        {shown.map((entry) => (
          <li key={entry.stack} className={`${PANEL} px-4 py-3`}>
            <div className="flex items-center gap-2">
              <Layers size={13} className="text-[var(--alc-fg-3)]" />
              <span className="font-serif text-[15px] text-[var(--alc-fg-1)]">
                {entry.stack}
              </span>
              {entry.stages.length === 0 && (
                <span className="ml-auto font-mono text-[10px] text-[var(--alc-fg-4)]">
                  no stages
                </span>
              )}
            </div>
            {entry.stages.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {[...entry.stages].sort().map((stage) => (
                  <button
                    key={stage}
                    onClick={() =>
                      navigate(pathOf({ stack: entry.stack, stage }))
                    }
                    className="group flex items-center gap-1 rounded-[var(--alc-radius-sm)] border border-[var(--alc-hairline-3)] px-2 py-1 font-mono text-[11px] text-[var(--alc-fg-2)] transition-colors duration-[var(--alc-dur)] hover:border-[var(--alc-fg-4)] hover:text-[var(--alc-fg-1)]"
                  >
                    {stage}
                    <ChevronRight
                      size={11}
                      className="text-[var(--alc-fg-4)] transition-transform duration-[var(--alc-dur)] group-hover:translate-x-0.5"
                    />
                  </button>
                ))}
              </div>
            )}
          </li>
        ))}
        {shown.length === 0 && (
          <li className="px-1 py-6 text-[13px] text-[var(--alc-fg-3)]">
            {stacks.length === 0
              ? "The state store has no stacks yet — deploy something."
              : "No stacks match that filter."}
          </li>
        )}
      </ul>
    </main>
  );
}
