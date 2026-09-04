import { Check, ChevronDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { MENU_ITEM, PANEL } from "../theme.ts";

/**
 * Stack picker: choose one of the stacks in the state store.
 *
 * Only rendered by the hosted viewer, where `/api/stacks` returns more
 * than one — the CLI dashboard drives exactly one stack, so there is
 * nothing to pick and the stack name stays plain text.
 *
 * Unlike {@link StageSelect} there is no free-text entry: a stage can be
 * previewed before it exists (the server plans it), but a stack that is
 * not in the store has no state to show.
 *
 * A stack whose stages have all been destroyed stays in the list but is
 * NOT selectable — the store still registers the stack, so hiding it
 * would make the list lie, and selecting it can only 404.
 */
export function StackSelect({
  stack,
  stacks,
  onSelect,
}: {
  stack: string;
  stacks: readonly { stack: string; stages: readonly string[] }[];
  onSelect: (stack: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  const filtered = input.trim()
    ? stacks.filter((s) =>
        s.stack.toLowerCase().includes(input.trim().toLowerCase()),
      )
    : stacks;

  const choose = (entry: { stack: string; stages: readonly string[] }) => {
    if (entry.stages.length === 0) {
      return;
    }
    onSelect(entry.stack);
    setOpen(false);
    setInput("");
  };

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 rounded-[var(--alc-radius-sm)] px-1 py-0.5 transition-colors duration-[var(--alc-dur)] hover:bg-[var(--alc-bg-elev-1)]"
      >
        <span className="font-serif text-[15px] font-medium tracking-[-0.01em] text-[var(--alc-fg-1)]">
          {stack}
        </span>
        <ChevronDown size={12} className="text-[var(--alc-fg-2)]" />
      </button>
      {open && (
        <div
          className={`${PANEL} absolute left-0 top-8 z-20 w-64 overflow-hidden`}
        >
          <input
            autoFocus
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              const first = filtered.find((s) => s.stages.length > 0);
              if (e.key === "Enter" && first) {
                choose(first);
              }
              if (e.key === "Escape") {
                setOpen(false);
              }
            }}
            placeholder="Filter stacks…"
            className="w-full border-b border-[var(--alc-hairline)] bg-transparent px-3 py-2 font-mono text-[12px] text-[var(--alc-fg-1)] placeholder:text-[var(--alc-fg-4)] focus:outline-none"
          />
          <div className="max-h-72 overflow-y-auto py-1">
            {filtered.map((s) => {
              const empty = s.stages.length === 0;
              return (
                <button
                  key={s.stack}
                  onClick={() => choose(s)}
                  disabled={empty}
                  title={
                    empty ? "no deployed stages — nothing to show" : undefined
                  }
                  className={`${MENU_ITEM} ${empty ? "cursor-not-allowed opacity-40" : ""}`}
                >
                  <span className="w-3">
                    {s.stack === stack && (
                      <Check size={12} className="text-[var(--alc-accent)]" />
                    )}
                  </span>
                  <span className="font-mono">{s.stack}</span>
                  <span className="ml-auto pl-2 font-mono text-[10px] text-[var(--alc-fg-4)]">
                    {empty
                      ? "no stages"
                      : s.stages.length === 1
                        ? "1 stage"
                        : `${s.stages.length} stages`}
                  </span>
                </button>
              );
            })}
            {filtered.length === 0 && (
              <p className="px-3 py-1.5 text-[11px] text-[var(--alc-fg-4)]">
                no matching stacks
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
