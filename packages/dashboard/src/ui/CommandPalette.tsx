import { Check, CornerDownLeft, Layers, Search } from "lucide-react";
import { setStage } from "../ingest.ts";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import {
  dashboardStore,
  setPaletteOpen,
  setSelectedFqn,
  setView,
  usePaletteOpen,
  useStructuralHash,
  type ViewKind,
} from "../store.ts";
import { PANEL, typeName } from "../theme.ts";
import { safeUI, useRegistry } from "../uiRegistry.ts";
import { ResourceIcon } from "./Icon.tsx";
import { VIEW_LABELS, VIEW_ORDER } from "./views.ts";

/**
 * ⌘K command palette: jump to a view ("Go to: Graph") or to a resource
 * (rendered like a List row — icon, logical id, path, friendly type).
 * Selecting a resource opens its Inspector in whatever view is active.
 */
export function CommandPalette() {
  const open = usePaletteOpen();

  // global hotkey — always armed, palette or not
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen(!dashboardStore.getState().ui.paletteOpen);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!open) {
    return null;
  }
  return <Palette />;
}

interface ViewItem {
  kind: "view";
  view: ViewKind;
  label: string;
}

interface ResourceItem {
  kind: "resource";
  fqn: string;
  logicalId: string;
  path: readonly string[];
  type: string;
}

interface StageItem {
  kind: "stage";
  stage: string;
  /** true = not a known stage, previews fresh */
  custom: boolean;
  current: boolean;
}

/** "Go to Stage…" — flips the palette into the stage selector. */
interface StageCommandItem {
  kind: "stage-command";
}

type Item = ViewItem | ResourceItem | StageItem | StageCommandItem;

/** union of the server's stage list, everything seen, and the current stage */
const knownStages = (): { stages: string[]; current: string } => {
  const { document, layout } = dashboardStore.getState();
  const current = document.meta.stage;
  return {
    stages: [
      ...new Set([
        ...(document.meta.stages ?? []),
        ...layout.stagesSeen,
        current,
      ]),
    ]
      .filter((s) => s !== "")
      .sort(),
    current,
  };
};

/** "QueueConsumer" → "Queue Consumer" (friendly type display). */
const humanize = (type: string): string =>
  typeName(type).replace(/([a-z0-9])([A-Z])/g, "$1 $2");

const MAX_RESOURCES = 12;

const Palette = memo(function Palette() {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  // "root" = everything; "stage" = the Go-to-Stage sub-prompt (same
  // selector semantics as the TopBar StageSelect)
  const [mode, setMode] = useState<"root" | "stage">("root");
  const hash = useStructuralHash();
  const listRef = useRef<HTMLDivElement>(null);

  const items = useMemo<Item[]>(() => {
    const q = query.trim().toLowerCase();
    const raw = query.trim();
    const { stages, current } = knownStages();

    if (mode === "stage") {
      const matches: Item[] = stages
        .filter((stage) => q === "" || stage.toLowerCase().includes(q))
        .map((stage) => ({
          kind: "stage",
          stage,
          custom: false,
          current: stage === current,
        }));
      if (raw !== "" && !stages.includes(raw)) {
        matches.push({
          kind: "stage",
          stage: raw,
          custom: true,
          current: false,
        });
      }
      return matches;
    }

    const views: ViewItem[] = VIEW_ORDER.filter(
      (view) => q === "" || VIEW_LABELS[view].toLowerCase().includes(q),
    ).map((view) => ({ kind: "view", view, label: VIEW_LABELS[view] }));
    // structure content is covered by the hash (the memo dep); read the
    // node map imperatively
    const { document } = dashboardStore.getState();
    const resources: ResourceItem[] = [];
    for (const node of document.structure.nodes.values()) {
      if (
        q !== "" &&
        !node.logicalId.toLowerCase().includes(q) &&
        !node.fqn.toLowerCase().includes(q) &&
        !node.type.toLowerCase().includes(q) &&
        !humanize(node.type).toLowerCase().includes(q)
      ) {
        continue;
      }
      resources.push({
        kind: "resource",
        fqn: node.fqn,
        logicalId: node.logicalId,
        path: node.path,
        type: node.type,
      });
      if (resources.length >= MAX_RESOURCES) {
        break;
      }
    }
    // ALWAYS offer the typed text as a stage jump (Cmd+K → "prod" →
    // Enter, no arrowing when nothing else matches), plus any known
    // stages the query matches.
    const stageJumps: StageItem[] = [];
    if (q !== "") {
      for (const stage of stages) {
        if (stage.toLowerCase().includes(q) && stage !== current) {
          stageJumps.push({
            kind: "stage",
            stage,
            custom: false,
            current: false,
          });
        }
      }
      if (!stages.includes(raw)) {
        stageJumps.push({
          kind: "stage",
          stage: raw,
          custom: true,
          current: false,
        });
      }
    }
    const stageCommand: StageCommandItem[] =
      q === "" || "go to stage".includes(q) || "stage".startsWith(q)
        ? [{ kind: "stage-command" }]
        : [];
    // with a query, resources first (that's what you're usually hunting);
    // empty query leads with the three views
    return q === ""
      ? [...views, ...stageCommand, ...resources]
      : [...resources, ...views, ...stageJumps, ...stageCommand];
  }, [query, hash, mode]);

  const clamped = Math.min(index, Math.max(0, items.length - 1));

  const execute = (item: Item) => {
    switch (item.kind) {
      case "view":
        setView(item.view);
        break;
      case "resource":
        setSelectedFqn(item.fqn);
        break;
      case "stage":
        setStage(item.stage);
        break;
      case "stage-command":
        // flip into the stage prompt instead of closing
        setMode("stage");
        setQuery("");
        setIndex(0);
        return;
    }
    setPaletteOpen(false);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/25 pt-[14vh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) {
          setPaletteOpen(false);
        }
      }}
    >
      <div className={`${PANEL} w-[560px] max-w-[90vw] overflow-hidden`}>
        <div className="flex items-center gap-2.5 border-b border-[var(--alc-hairline)] px-3.5">
          <Search size={14} className="shrink-0 text-[var(--alc-fg-4)]" />
          {mode === "stage" && (
            <span className="shrink-0 rounded-[var(--alc-radius-sm)] border border-[var(--alc-hairline-2)] px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--alc-accent-deep)]">
              stage
            </span>
          )}
          <input
            autoFocus
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setIndex(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                if (mode === "stage") {
                  setMode("root");
                  setQuery("");
                  setIndex(0);
                } else {
                  setPaletteOpen(false);
                }
              } else if (
                e.key === "Backspace" &&
                query === "" &&
                mode === "stage"
              ) {
                setMode("root");
                setIndex(0);
              } else if (e.key === "ArrowDown") {
                e.preventDefault();
                setIndex((i) => Math.min(i + 1, items.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setIndex((i) => Math.max(i - 1, 0));
              } else if (e.key === "Enter" && items[clamped]) {
                execute(items[clamped]);
              }
            }}
            placeholder={
              mode === "stage"
                ? "Select or type a stage…"
                : "Search resources and views…"
            }
            className="w-full bg-transparent py-3 font-mono text-[13px] text-[var(--alc-fg-1)] placeholder:text-[var(--alc-fg-4)] focus:outline-none"
          />
          <kbd className="shrink-0 rounded-[var(--alc-radius-sm)] border border-[var(--alc-hairline-2)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--alc-fg-4)]">
            esc
          </kbd>
        </div>
        <div ref={listRef} className="max-h-[50vh] overflow-y-auto py-1.5">
          {items.length === 0 && (
            <p className="px-4 py-3 text-[12.5px] text-[var(--alc-fg-4)]">
              Nothing matches “{query.trim()}”
            </p>
          )}
          {items.map((item, i) => (
            <PaletteRow
              key={
                item.kind === "view"
                  ? `view:${item.view}`
                  : item.kind === "stage"
                    ? `stage:${item.stage}`
                    : item.kind === "stage-command"
                      ? "cmd:stage"
                      : item.fqn
              }
              item={item}
              active={i === clamped}
              onHover={() => setIndex(i)}
              onPick={() => execute(item)}
            />
          ))}
        </div>
      </div>
    </div>
  );
});

const ROW_BASE =
  "flex w-full items-center gap-2.5 px-3.5 py-2 text-left text-[13px] transition-colors duration-[var(--alc-dur-fast)]";

function PaletteRow({
  item,
  active,
  onHover,
  onPick,
}: {
  item: Item;
  active: boolean;
  onHover: () => void;
  onPick: () => void;
}) {
  const registry = useRegistry();
  const activeClass = active ? "bg-[var(--alc-accent-12)]" : "";
  if (item.kind === "stage-command") {
    return (
      <button
        className={`${ROW_BASE} ${activeClass}`}
        onMouseMove={onHover}
        onClick={onPick}
      >
        <Layers size={13} className="text-[var(--alc-fg-4)]" />
        <span className="text-[var(--alc-fg-3)]">
          Go to{" "}
          <span className="font-medium text-[var(--alc-fg-1)]">Stage…</span>
        </span>
      </button>
    );
  }
  if (item.kind === "stage") {
    return (
      <button
        className={`${ROW_BASE} ${activeClass}`}
        onMouseMove={onHover}
        onClick={onPick}
      >
        {item.current ? (
          <Check size={13} className="text-[var(--alc-accent)]" />
        ) : (
          <Layers size={13} className="text-[var(--alc-fg-4)]" />
        )}
        <span className="text-[var(--alc-fg-3)]">
          {item.custom ? "Select stage: " : "Select stage: "}
          <span className="font-mono font-medium text-[var(--alc-fg-1)]">
            {item.stage}
          </span>
        </span>
        {item.custom && (
          <span className="ml-auto text-[11px] text-[var(--alc-success)]">
            preview new stage
          </span>
        )}
      </button>
    );
  }
  if (item.kind === "view") {
    return (
      <button
        className={`${ROW_BASE} ${activeClass}`}
        onMouseMove={onHover}
        onClick={onPick}
      >
        <CornerDownLeft size={13} className="text-[var(--alc-fg-4)]" />
        <span className="text-[var(--alc-fg-3)]">
          Go to:{" "}
          <span className="font-medium text-[var(--alc-fg-1)]">
            {item.label}
          </span>
        </span>
      </button>
    );
  }
  const { document } = dashboardStore.getState();
  const node = document.structure.nodes.get(item.fqn);
  const ui = node !== undefined ? registry?.get(node.type) : undefined;
  const color = safeUI(() => ui?.color) ?? "var(--alc-muted)";
  return (
    <button
      className={`${ROW_BASE} ${activeClass}`}
      onMouseMove={onHover}
      onClick={onPick}
    >
      <ResourceIcon ui={ui} color={color} size={14} kind={node?.kind} />
      <span className="font-medium text-[var(--alc-fg-1)]">
        {item.logicalId}
      </span>
      {item.path.length > 0 && (
        <span className="font-mono text-[11px] text-[var(--alc-fg-4)]">
          {item.path.join("/")}
        </span>
      )}
      <span className="text-[12px] text-[var(--alc-fg-3)]">
        {humanize(item.type)}
      </span>
    </button>
  );
}
