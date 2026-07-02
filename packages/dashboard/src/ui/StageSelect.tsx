import { Check, ChevronDown, CornerDownLeft } from "lucide-react";
import { useEffect, useRef, useState } from "react";

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
        className="flex items-center gap-1.5 rounded-full border border-[#2a2a35] px-2.5 py-0.5 text-[11px] text-zinc-400 hover:border-[#3a3a48] hover:text-zinc-200"
      >
        stage: <span className="text-zinc-200">{stage}</span>
        <ChevronDown size={11} />
      </button>
      {open && (
        <div className="absolute left-0 top-7 z-20 w-56 overflow-hidden rounded-xl border border-[#2a2a35] bg-[#15151c] shadow-xl shadow-black/40">
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
            className="w-full border-b border-[#26262f] bg-transparent px-3 py-2 text-[12px] text-zinc-200 placeholder:text-zinc-600 focus:outline-none"
          />
          <div className="max-h-56 overflow-y-auto py-1">
            {filtered.map((s) => (
              <button
                key={s}
                onClick={() => choose(s)}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-zinc-300 hover:bg-[#1c1c24]"
              >
                <span className="w-3">
                  {s === stage && (
                    <Check size={12} className="text-indigo-400" />
                  )}
                </span>
                {s}
              </button>
            ))}
            {custom && (
              <button
                onClick={() => choose(custom)}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-emerald-400 hover:bg-[#1c1c24]"
              >
                <CornerDownLeft size={12} className="ml-0.5" />
                preview new stage “{custom}”
              </button>
            )}
            {filtered.length === 0 && !custom && (
              <p className="px-3 py-1.5 text-[11px] text-zinc-600">
                no matching stages
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
