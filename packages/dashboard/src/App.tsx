import { memo, type CSSProperties } from "react";
import {
  useApproval,
  useConnection,
  useDeployment,
  useFilterCounts,
  useHydrated,
  useMeta,
  useView,
} from "./store.ts";
import { SERIF_HEADING } from "./theme.ts";
import { ActivityFeed } from "./ui/ActivityFeed.tsx";
import { DeploymentBanner } from "./ui/DeploymentBanner.tsx";
import { Yantra } from "./ui/Brand.tsx";
import { Canvas } from "./ui/Canvas.tsx";
import { Inspector } from "./ui/Inspector.tsx";
import { ListView } from "./ui/ListView.tsx";
import { TopBar } from "./ui/TopBar.tsx";
import { CommandPalette } from "./ui/CommandPalette.tsx";
import { SummaryView } from "./views/Summary.tsx";

/**
 * v2 shell. App itself subscribes ONLY to the hydration gate and the
 * (rarely-changing) connection status; everything else (top bar, views,
 * inspector, feed, approval) subscribes to its own store slice, so live
 * patches re-render exactly the affected leaves. Data flows exclusively
 * through store hooks — no scene objects, no prop-drilled meta.
 */
export function App() {
  const hydrated = useHydrated();
  const connection = useConnection();
  if (connection.status === "superseded") {
    return <SupersededScreen />;
  }
  if (!hydrated) {
    return <BootScreen />;
  }
  return (
    <div className="flex h-screen flex-col bg-[var(--alc-bg)]">
      <TopBar />
      <div className="relative flex min-h-0 flex-1">
        <DeploymentBanner />
        <ActivityFeed />
        <ViewHost />
        <Inspector />
      </div>
      <CommandPalette />
    </div>
  );
}

/**
 * A newer dashboard tab took over (BroadcastChannel takeover) and the
 * browser refused to script-close this one — make it read as dead so
 * exactly one tab looks live.
 */
function SupersededScreen() {
  return (
    <div className="flex h-screen w-full flex-col items-center justify-center bg-[var(--alc-bg)]">
      <Yantra
        size={44}
        strokeWidth={1.1}
        className="text-[var(--alc-fg-4)] opacity-60"
      />
      <h1 className={`${SERIF_HEADING} mt-5 text-[22px]`}>
        Moved to a newer tab
      </h1>
      <p className="mt-3 text-sm text-[var(--alc-fg-3)]">
        Another dashboard tab took over — you can close this one.
      </p>
    </div>
  );
}

/** Pre-hydration gate: waiting for the first snapshot frame. */
function BootScreen() {
  const connection = useConnection();
  return (
    <div className="flex h-screen w-full flex-col items-center justify-center bg-[var(--alc-bg)]">
      <Yantra
        size={44}
        strokeWidth={1.1}
        className={`text-[var(--alc-accent-deep)] ${
          connection.status === "error" ? "" : "animate-pulse"
        }`}
      />
      <h1 className={`${SERIF_HEADING} mt-5 text-[22px]`}>alchemy dashboard</h1>
      {connection.status === "error" ? (
        <>
          <p className="mt-3 text-sm text-[var(--alc-danger)]">
            Cannot reach the dashboard server
          </p>
          <p className="mt-2 text-[12px] text-[var(--alc-fg-3)]">
            Is{" "}
            <code className="rounded-[var(--alc-radius-sm)] border border-[var(--alc-hairline)] bg-[var(--alc-bg-sunk)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--alc-fg-1)]">
              alchemy dashboard
            </code>{" "}
            running? Retrying…
          </p>
        </>
      ) : (
        <p className="mt-3 animate-pulse text-sm text-[var(--alc-fg-3)]">
          Loading stack…
        </p>
      )}
    </div>
  );
}

const CANVAS_VISIBLE: CSSProperties = { visibility: "visible" };
// visibility (not display) keeps React Flow's container measured, so
// returning to the canvas restores the exact viewport with zero jump
const CANVAS_HIDDEN: CSSProperties = { visibility: "hidden" };

/**
 * Main content area. The Canvas is ALWAYS mounted — other views render in
 * an overlay above it while it is CSS-hidden, so switching views never
 * unmounts React Flow state (positions/viewport survive by identity).
 */
const ViewHost = memo(function ViewHost() {
  const view = useView();
  return (
    <main className="relative min-w-0 flex-1">
      <div
        className="absolute inset-0"
        style={view === "canvas" ? CANVAS_VISIBLE : CANVAS_HIDDEN}
      >
        <Canvas />
      </div>
      {view === "canvas" && <CanvasEmptyState />}
      {view !== "canvas" && (
        <div className="absolute inset-0 z-10 overflow-y-auto bg-[var(--alc-bg)]">
          {view === "summary" ? <SummaryView /> : <ListView />}
        </div>
      )}
    </main>
  );
});

/**
 * Shown over the (empty) canvas when the document has no structure. Says
 * WHAT KIND of empty this is:
 * - a pending run/approval with nothing in it → "nothing to do"
 * - a stage with deployment history but no resources → "stage is empty"
 * - otherwise → still waiting for the structure/plan passes (pulse)
 */
const CanvasEmptyState = memo(function CanvasEmptyState() {
  const counts = useFilterCounts();
  const meta = useMeta();
  const approval = useApproval();
  const deployment = useDeployment();
  if (counts.total > 0) {
    return null;
  }
  const settled = approval !== undefined || deployment !== undefined;
  const message =
    approval !== undefined
      ? "Nothing to do — no resources are deployed to this stage"
      : deployment !== undefined
        ? "Stage is empty — no resources deployed"
        : "Waiting for resources…";
  return (
    <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
      {/* faint alchemical watermark — decorative only */}
      <Yantra
        size={220}
        strokeWidth={0.5}
        className="absolute text-[var(--alc-fg-1)] opacity-[0.04]"
      />
      <p
        className={`${SERIF_HEADING} ${settled ? "" : "animate-pulse"} text-[17px]`}
      >
        {message}
      </p>
      <p className="mt-2 font-mono text-[12px] text-[var(--alc-fg-3)]">
        {meta.stack}/{meta.stage}
      </p>
    </div>
  );
});
