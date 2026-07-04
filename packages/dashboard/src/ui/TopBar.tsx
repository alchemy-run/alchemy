import { Maximize, Moon, Search, Sun, X } from "lucide-react";
import { memo } from "react";
import { setStage } from "../ingest.ts";
import {
  requestFit,
  setFilter,
  setView,
  useConnection,
  useFilter,
  useFilterCounts,
  useMeta,
  useProjection,
  useView,
  type ViewKind,
} from "../store.ts";
import {
  CHIP,
  chipStyle,
  HAIRLINE_BUTTON,
  PLAN_COLORS,
  PLAN_LABELS,
  SUNK_INPUT,
} from "../theme.ts";
import { useThemeMode } from "../themeMode.ts";
import { Yantra } from "./Brand.tsx";
import { DeploymentPicker, HistoricalPill } from "./DeploymentPicker.tsx";
import { StageSelect } from "./StageSelect.tsx";

const VIEWS: readonly ViewKind[] = [
  "canvas",
  "summary",
  "list",
  "table",
  "waterfall",
  "annotations",
];

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
      <FilterBox />
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
  return (
    <span className="font-serif text-[15px] font-medium tracking-[-0.01em] text-[var(--alc-fg-1)]">
      {meta.stack}
    </span>
  );
}

function StageArea() {
  const meta = useMeta();
  return (
    <StageSelect
      stage={meta.stage}
      stages={meta.stages ?? []}
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
        className={`${CHIP} border border-[var(--alc-hairline-2)] text-[var(--alc-success)]`}
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

/**
 * Filter box + match-count chip. Filtering is decoration-only (dims
 * non-matching nodes) — it NEVER touches layout, positions, or viewport.
 */
const FILTER_ACTIVE_STYLE = chipStyle("var(--alc-warn)");

function FilterBox() {
  const filter = useFilter();
  const counts = useFilterCounts();
  const active = filter.trim() !== "";
  return (
    <>
      <div className="relative ml-4 max-w-xs flex-1">
        <Search
          size={13}
          className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--alc-fg-4)]"
        />
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter resources…"
          className={`${SUNK_INPUT} w-full py-1.5 pl-8 pr-8 ${
            active
              ? "border-[var(--alc-warn)] focus:border-[var(--alc-warn)]"
              : ""
          }`}
        />
        {active && (
          <button
            onClick={() => setFilter("")}
            title="Clear filter"
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded-[var(--alc-radius-sm)] p-0.5 text-[var(--alc-fg-4)] transition-colors duration-[var(--alc-dur-fast)] hover:bg-[var(--alc-accent-12)] hover:text-[var(--alc-fg-1)]"
          >
            <X size={12} />
          </button>
        )}
      </div>
      {active && (
        <button
          onClick={() => setFilter("")}
          className={`${CHIP} transition-colors duration-[var(--alc-dur-fast)]`}
          style={FILTER_ACTIVE_STYLE}
          title="Click to clear the filter"
        >
          filtered: {counts.shown} of {counts.total} shown ✕
        </button>
      )}
    </>
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
    <div className="flex rounded-[var(--alc-radius)] border border-[var(--alc-hairline-2)] p-0.5">
      {VIEWS.map((v) => (
        <button
          key={v}
          onClick={() => setView(v)}
          className={`rounded-[var(--alc-radius-sm)] px-2.5 py-1 text-[12px] capitalize transition-colors duration-[var(--alc-dur)] ${
            view === v
              ? "bg-[var(--alc-accent-12)] font-medium text-[var(--alc-accent-deep)]"
              : "text-[var(--alc-fg-3)] hover:text-[var(--alc-fg-1)]"
          }`}
        >
          {v}
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
