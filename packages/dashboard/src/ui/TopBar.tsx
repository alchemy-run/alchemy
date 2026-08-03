import { Maximize, Moon, Search, Sun } from "lucide-react";
import { memo, useMemo } from "react";
import { setStack, setStage } from "../ingest.ts";
import {
  requestFit,
  setPaletteOpen,
  setView,
  useConnection,
  useMeta,
  useProjection,
  useSeenStages,
  useStacks,
  useView,
} from "../store.ts";
import {
  CHIP,
  chipStyle,
  HAIRLINE_BUTTON,
  PLAN_COLORS,
  PLAN_LABELS,
} from "../theme.ts";
import { useThemeMode } from "../themeMode.ts";
import { Yantra } from "./Brand.tsx";
import { DeploymentPicker, HistoricalPill } from "./DeploymentPicker.tsx";
import { StackSelect } from "./StackSelect.tsx";
import { StageSelect } from "./StageSelect.tsx";
import { VIEW_LABELS, VIEW_ORDER } from "./views.ts";

/**
 * The shell header. TopBar itself subscribes to NOTHING — each child
 * subscribes to its own store slice, so a live deploy re-renders only the
 * plan chips, and typing in the filter re-renders only the filter box.
 */
export const TopBar = memo(function TopBar() {
  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-[var(--alc-hairline-2)] bg-[var(--alc-bg-nav)] px-4">
      <Yantra size={18} className="shrink-0 text-[var(--alc-accent-deep)]" />
      <StackName />
      <StageArea />
      <ConnectionDot />
      <PlanChips />
      <PaletteButton />
      <div className="ml-auto flex items-center gap-2">
        <HistoricalPill />
        <DeploymentPicker />
        <FitButton />
        <ViewTabs />
        <ThemeToggle />
      </div>
    </header>
  );
});

function StackName() {
  const meta = useMeta();
  const stacks = useStacks();
  // The CLI dashboard drives exactly one stack (and 404s /api/stacks), so
  // it keeps the plain label; the hosted viewer gets a picker.
  if (stacks.length < 2) {
    return (
      <span className="font-serif text-[15px] font-medium tracking-[-0.01em] text-[var(--alc-fg-1)]">
        {meta.stack}
      </span>
    );
  }
  return (
    <StackSelect
      stack={meta.stack}
      stacks={stacks}
      onSelect={(stack) => setStack(stack)}
    />
  );
}

function StageArea() {
  const meta = useMeta();
  // union of the server's list, the catalog's stages for this stack, and
  // every stage this client has ever seen (persisted per stack) —
  // switching to a new stage never hides the ones you came from
  const seen = useSeenStages();
  const stacks = useStacks();
  const stages = useMemo(() => {
    const catalog =
      stacks.find((s) => s.stack === meta.stack)?.stages ?? ([] as const);
    return [...new Set([...(meta.stages ?? []), ...catalog, ...seen])].sort();
  }, [meta.stages, meta.stack, stacks, seen]);
  return (
    <StageSelect
      stage={meta.stage}
      stages={stages}
      onSelect={(stage) => setStage(stage)}
    />
  );
}

const CONNECTING_STYLE = chipStyle("var(--alc-warn)");
const ERROR_STYLE = chipStyle("var(--alc-danger)");

function ConnectionDot() {
  const connection = useConnection();
  if (connection.status === "live") {
    return null;
  }
  const connecting = connection.status === "connecting";
  return (
    <span
      className={`${CHIP} ${connecting ? "animate-pulse" : ""}`}
      style={connecting ? CONNECTING_STYLE : ERROR_STYLE}
      title={
        connecting
          ? "Connecting to the dashboard server…"
          : "Connection lost — reconnecting"
      }
    >
      {connecting ? "connecting…" : "reconnecting…"}
    </span>
  );
}

/** Pending-plan action counts (from the summary projection). */
function PlanChips() {
  const summary = useProjection("summary");
  const entries = Object.entries(summary.counts.byPlanAction).filter(
    ([, count]) => count > 0,
  );
  if (entries.length === 0) {
    return (
      <span
        className={`${CHIP} border border-[var(--alc-hairline-3)] bg-[var(--alc-bg-elev-1)] text-[var(--alc-success)]`}
      >
        ✓ in sync
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1.5">
      {entries.map(([action, count]) => (
        <span
          key={action}
          className={CHIP}
          style={chipStyle(PLAN_COLORS[action] ?? "var(--alc-muted)")}
          title={`next deploy will ${action} ${count} resource${count > 1 ? "s" : ""}`}
        >
          {count} {PLAN_LABELS[action]?.slice(2) ?? action}
        </span>
      ))}
    </span>
  );
}

/** Opens the ⌘K command palette — search resources, jump between views. */
function PaletteButton() {
  return (
    <button
      onClick={() => setPaletteOpen(true)}
      title="Search resources and views (⌘K)"
      className="ml-4 flex max-w-xs flex-1 items-center gap-2 rounded-[var(--alc-radius)] border border-[var(--alc-hairline-3)] bg-[var(--alc-bg-elev-2)] px-2.5 py-1.5 text-left shadow-[var(--alc-shadow-sm)] transition-colors duration-[var(--alc-dur)] hover:border-[var(--alc-fg-4)]"
    >
      <Search size={13} className="shrink-0 text-[var(--alc-fg-3)]" />
      <span className="flex-1 truncate font-mono text-[12px] text-[var(--alc-fg-3)]">
        Search…
      </span>
      <kbd className="shrink-0 rounded-[var(--alc-radius-sm)] border border-[var(--alc-hairline-3)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--alc-fg-3)]">
        ⌘K
      </kbd>
    </button>
  );
}

/** Explicit re-fit — the ONLY way to move the viewport besides the user. */
function FitButton() {
  const view = useView();
  if (view !== "canvas") {
    return null;
  }
  return (
    <button
      onClick={requestFit}
      title="Fit the graph to the viewport"
      className={`${HAIRLINE_BUTTON} p-1.5`}
    >
      <Maximize size={13} />
    </button>
  );
}

function ViewTabs() {
  const view = useView();
  return (
    <div className="flex rounded-[var(--alc-radius)] border border-[var(--alc-hairline-3)] bg-[var(--alc-bg-elev-1)] p-0.5 shadow-[var(--alc-shadow-sm)]">
      {VIEW_ORDER.map((v) => (
        <button
          key={v}
          onClick={() => setView(v)}
          className={`rounded-[var(--alc-radius-sm)] px-2.5 py-1 text-[12px] transition-colors duration-[var(--alc-dur)] ${
            view === v
              ? "bg-[var(--alc-accent-12)] font-medium text-[var(--alc-accent-deep)]"
              : "text-[var(--alc-fg-2)] hover:text-[var(--alc-fg-1)]"
          }`}
        >
          {VIEW_LABELS[v]}
        </button>
      ))}
    </div>
  );
}

/**
 * Binary toggle on the RESOLVED theme. "auto" is only ever the initial
 * (nothing-stored) state — cycling through it made the first click a
 * visual no-op whenever auto already resolved to the current look, which
 * read as "takes two clicks to switch".
 */
function ThemeToggle() {
  const { resolved, setMode } = useThemeMode();
  const next = resolved === "dark" ? "light" : "dark";
  return (
    <button
      onClick={() => setMode(next)}
      title={`Switch to ${next} mode`}
      className={`${HAIRLINE_BUTTON} p-1.5`}
    >
      {resolved === "dark" ? <Moon size={13} /> : <Sun size={13} />}
    </button>
  );
}
