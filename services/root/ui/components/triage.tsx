/**
 * The TRIAGE PANEL — the valve in the humans' hand. Inbound GitHub
 * events wait HERE (held, deduped, oldest first) until a human
 * releases them into the engineering manager's inbox — one, several,
 * or all — or flips the valve to auto and lets the stream flow. While
 * the company is young, nothing gets processed without a click.
 */
import { cn } from "@/lib/utils";
import { ArrowRight, Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

export interface HeldInbound {
  readonly seq: number;
  readonly ref?: string;
  readonly kind: "issue" | "pull" | "request";
  readonly text: string;
  readonly at: number;
}

interface TriageState {
  readonly mode: "manual" | "auto";
  readonly held: ReadonlyArray<HeldInbound>;
}

/** Poll the valve — the header badge and the panel share it. */
export const useTriage = (): TriageState | undefined => {
  const [state, setState] = useState<TriageState | undefined>(undefined);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () => {
      fetch("/api/triage")
        .then(async (response) => {
          if (!live || !response.ok) return;
          setState((await response.json()) as TriageState);
        })
        .catch(() => {})
        .finally(() => {
          if (live) timer = setTimeout(load, 4_000);
        });
    };
    load();
    return () => {
      live = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, []);
  return state;
};

export const TriagePanel = () => {
  const [state, setState] = useState<TriageState | undefined>(undefined);
  const [busy, setBusy] = useState<ReadonlyArray<number> | "all" | undefined>(
    undefined,
  );

  const load = useCallback(() => {
    fetch("/api/triage")
      .then(async (response) => {
        if (response.ok) setState((await response.json()) as TriageState);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, 4_000);
    return () => clearInterval(timer);
  }, [load]);

  const release = (seqs?: ReadonlyArray<number>) => {
    setBusy(seqs ?? "all");
    fetch("/api/triage/release", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(seqs === undefined ? {} : { seqs }),
    })
      .then(load)
      .finally(() => setBusy(undefined));
  };

  const setMode = (mode: "manual" | "auto") => {
    fetch("/api/triage/mode", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode }),
    }).then(load);
  };

  if (state === undefined) {
    return (
      <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> reading the valve…
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <div className="text-sm">
          <span className="font-medium">{state.held.length}</span>{" "}
          <span className="text-muted-foreground">
            inbound held — nothing reaches the manager until released
          </span>
        </div>
        <div className="flex items-center gap-1">
          {(["manual", "auto"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => setMode(mode)}
              aria-label={`${mode} mode`}
              className={cn(
                "cursor-pointer rounded border border-border/60 px-2 py-0.5 font-mono text-[11px]",
                state.mode === mode
                  ? "border-moss bg-moss/10 text-foreground"
                  : "text-muted-foreground hover:bg-accent",
              )}
            >
              {mode}
            </button>
          ))}
          <button
            type="button"
            onClick={() => release()}
            disabled={state.held.length === 0 || busy !== undefined}
            className="ml-2 cursor-pointer rounded border border-border px-2 py-0.5 text-[11px] hover:bg-accent disabled:opacity-50"
          >
            release all
          </button>
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-2">
        {state.held.length === 0 && (
          <div className="p-2 text-sm text-muted-foreground">
            The queue is empty — the world is quiet
            {state.mode === "auto" ? " (auto: releases flow through)" : ""}.
          </div>
        )}
        {state.held.map((item) => (
          <div
            key={item.seq}
            data-held={item.seq}
            className="flex items-center gap-2 rounded-md border border-border/60 px-2 py-1.5"
          >
            <span className="shrink-0 rounded bg-muted px-1 font-mono text-[10px] text-muted-foreground">
              {item.kind}
            </span>
            <span className="min-w-0 flex-1 truncate text-[13px]" title={item.text}>
              {item.text}
            </span>
            <button
              type="button"
              onClick={() => release([item.seq])}
              disabled={busy !== undefined}
              aria-label={`release inbound ${item.seq}`}
              title="release into the manager's inbox"
              className="flex shrink-0 cursor-pointer items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[11px] hover:bg-accent disabled:opacity-50"
            >
              release <ArrowRight className="size-3" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
};
