import { Check, ChevronDown, CornerDownLeft } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { MENU_ITEM, PANEL } from "../theme.ts";

/**
 * Stage picker: choose one of the stages known to the state store, or type
 * any stage name to preview it (the server re-evaluates the stack effect
 * under that stage and plans it — a never-deployed stage shows the whole
 * graph as `+ create`).
 */
export function StageSelect({
  stage,
  stages,
  onSelect,
}: {
  stage: string;
  stages: string[];
  onSelect: (stage: string) => void;
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

  const known = [...new Set([...stages, stage])].sort();
  const filtered = input.trim()
    ? known.filter((s) => s.toLowerCase().includes(input.toLowerCase()))
    : known;
  const custom =
    input.trim().length > 0 && !known.includes(input.trim())
      ? input.trim()
      : undefined;

  const choose = (s: string) => {
    onSelect(s);
    setOpen(false);
    setInput("");
  };

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 rounded-[var(--alc-radius-sm)] border border-[var(--alc-hairline-3)] bg-[var(--alc-bg-elev-1)] px-2 py-0.5 transition-colors duration-[var(--alc-dur)] hover:border-[var(--alc-fg-4)]"
      >
        <span className="font-mono text-[10px] font-medium uppercase tracking-[0.12em] text-[var(--alc-accent-deep)]">
          stage
        </span>
        <span className="font-mono text-[11px] text-[var(--alc-fg-1)]">
          {stage}
        </span>
        <ChevronDown size={11} className="text-[var(--alc-fg-2)]" />
      </button>
      {open && (
        <div
          className={`${PANEL} absolute left-0 top-7 z-20 w-56 overflow-hidden`}
        >
          <input
            autoFocus
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (custom ?? filtered[0])) {
                choose(custom ?? filtered[0]!);
              }
              if (e.key === "Escape") {
                setOpen(false);
              }
            }}
            placeholder="Select or type a stage…"
            className="w-full border-b border-[var(--alc-hairline)] bg-transparent px-3 py-2 font-mono text-[12px] text-[var(--alc-fg-1)] placeholder:text-[var(--alc-fg-4)] focus:outline-none"
          />
          <div className="max-h-56 overflow-y-auto py-1">
            {filtered.map((s) => (
              <button key={s} onClick={() => choose(s)} className={MENU_ITEM}>
                <span className="w-3">
                  {s === stage && (
                    <Check size={12} className="text-[var(--alc-accent)]" />
                  )}
                </span>
                <span className="font-mono">{s}</span>
              </button>
            ))}
            {custom && (
              <button
                onClick={() => choose(custom)}
                className={`${MENU_ITEM} text-[var(--alc-success)]`}
              >
                <CornerDownLeft size={12} className="ml-0.5" />
                preview new stage “{custom}”
              </button>
            )}
            {filtered.length === 0 && !custom && (
              <p className="px-3 py-1.5 text-[11px] text-[var(--alc-fg-4)]">
                no matching stages
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
