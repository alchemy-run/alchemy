import type { UIRegistry } from "alchemy/UI/UIProvider";
import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchGraph, fetchMeta, fetchPlan } from "./api.ts";
import { useApplyStream } from "./live.ts";
import { mergePlan } from "./plan.ts";
import { loadRegistry } from "./registry.ts";
import type { DashboardGraph, DashboardMeta, DashboardPlan } from "./types.ts";
import { ActivityFeed } from "./ui/ActivityFeed.tsx";
import { Canvas } from "./ui/Canvas.tsx";
import { Inspector } from "./ui/Inspector.tsx";
import { ListView } from "./ui/ListView.tsx";
import { TopBar, type View } from "./ui/TopBar.tsx";

export function App() {
  const [meta, setMeta] = useState<DashboardMeta>();
  const [stageOverride, setStageOverride] = useState<string>();
  const [graph, setGraph] = useState<DashboardGraph>();
  const [plan, setPlan] = useState<DashboardPlan>();
  const [registry, setRegistry] = useState<UIRegistry>();
  const [error, setError] = useState<string>();
  const [selected, setSelected] = useState<string>();
  const [view, setView] = useState<View>("canvas");
  const [query, setQuery] = useState("");
  const [planStale, setPlanStale] = useState(false);
  const [dismissedSession, setDismissedSession] = useState<string>();

  const stage = stageOverride ?? meta?.stage;

  useEffect(() => {
    Promise.all([fetchMeta(), loadRegistry()])
      .then(([meta, registry]) => {
        setMeta(meta);
        setRegistry(registry);
      })
      .catch((e) => setError(String(e)));
  }, []);

  // graph + plan follow the selected stage; the plan is loaded
  // independently and best-effort (it can take a while — the server
  // re-evaluates the whole stack for the stage — and can be unavailable)
  const refresh = useCallback(() => {
    if (!stage) {
      return;
    }
    fetchGraph(stage)
      .then(setGraph)
      .catch((e) => setError(String(e)));
    // the plan refetch re-evaluates the whole stack and can take seconds;
    // planStale keeps the live session's plan rendered until it lands so
    // badges don't flash back to the pre-deploy plan
    setPlanStale(true);
    fetchPlan(stage)
      .then((p) => {
        setPlan(p);
        setPlanStale(false);
      })
      .catch(() => undefined);
  }, [stage]);

  useEffect(() => {
    setGraph(undefined);
    setPlan(undefined);
    setSelected(undefined);
    refresh();
  }, [refresh]);

  // live apply stream: while a deploy is running, its plan drives the
  // annotations and node statuses update in real time; on completion the
  // settled state + plan are refetched
  const rawLive = useApplyStream(refresh);
  // dismissing the activity feed also clears the session's result overlay
  const live =
    rawLive && rawLive.sessionId !== dismissedSession ? rawLive : undefined;

  // the live session's plan stays authoritative until the post-apply
  // refetch actually lands — never fall back to a stale pre-deploy plan
  const effectivePlan =
    live && (!live.done || planStale || plan === undefined) ? live.plan : plan;

  const merged = useMemo(() => {
    // during a live apply, don't gate the canvas on the (possibly slow)
    // graph fetch — the session's plan alone can synthesize every node
    const base = graph ?? (live ? { nodes: [], edges: [] } : undefined);
    if (!base) {
      return undefined;
    }
    const withPlan = mergePlan(base, effectivePlan);
    if (!live) {
      return withPlan;
    }
    const nodes = withPlan.nodes.map((node) => {
      const status = live.statuses.get(node.logicalId);
      const note =
        live.notes.get(node.logicalId) ?? status?.message ?? undefined;
      const logs = live.logs.get(node.logicalId);
      const applyResult = live.results.get(node.logicalId)?.result;
      if (!status && note === undefined && logs === undefined) {
        return node;
      }
      return {
        ...node,
        status: status?.status ?? node.status,
        note,
        logs,
        applyResult,
      };
    });
    // deleted resources vanish from state after the refresh — keep them on
    // the canvas as ghosts so the apply's full story stays visible until
    // the session is dismissed
    const present = new Set(nodes.map((n) => n.logicalId));
    for (const [logicalId, { result, type }] of live.results) {
      if (result === "deleted" && !present.has(logicalId)) {
        nodes.push({
          fqn: logicalId,
          logicalId,
          path: [],
          kind: "resource",
          type,
          status: "deleted",
          bindings: [],
          downstream: [],
          applyResult: "deleted",
          logs: live.logs.get(logicalId),
        });
      }
    }
    return { ...withPlan, nodes };
  }, [graph, effectivePlan, live]);

  const filtered = useMemo(() => {
    if (!merged) {
      return undefined;
    }
    if (!query.trim()) {
      return merged;
    }
    const q = query.toLowerCase();
    const nodes = merged.nodes.filter(
      (n) =>
        n.fqn.toLowerCase().includes(q) || n.type.toLowerCase().includes(q),
    );
    const keep = new Set(nodes.map((n) => n.fqn));
    return {
      nodes,
      edges: merged.edges.filter(
        (e) => keep.has(e.source) && keep.has(e.target),
      ),
    };
  }, [merged, query]);

  if (error) {
    return (
      <Center>
        <p className="text-sm text-red-400">Failed to load: {error}</p>
        <p className="mt-2 text-[12px] text-zinc-500">
          Is <code>alchemy dashboard</code> running?
        </p>
      </Center>
    );
  }
  if (!meta || !filtered || !registry || !stage) {
    return (
      <Center>
        <p className="text-sm text-zinc-500">Loading stack…</p>
      </Center>
    );
  }

  const effectiveMeta = { ...meta, stage };
  const selectedNode = filtered.nodes.find((n) => n.fqn === selected);

  return (
    <div className="flex h-screen flex-col">
      <TopBar
        meta={effectiveMeta}
        stage={stage}
        onStage={setStageOverride}
        plan={plan}
        view={view}
        onView={setView}
        query={query}
        onQuery={setQuery}
        shown={filtered.nodes.length}
        total={merged?.nodes.length ?? filtered.nodes.length}
      />
      <div className="relative flex min-h-0 flex-1">
        {live && (
          <ActivityFeed
            live={live}
            onDismiss={() => setDismissedSession(live.sessionId)}
          />
        )}
        <main className="relative min-w-0 flex-1">
          {/* keep the canvas mounted even when the node list is transiently
              empty (plan/graph/live handoffs) — unmount/remount pops the
              whole scene in and out */}
          {view === "canvas" ? (
            <Canvas
              graph={filtered}
              registry={registry}
              meta={effectiveMeta}
              selected={selected}
              onSelect={setSelected}
            />
          ) : (
            <ListView
              nodes={filtered.nodes}
              registry={registry}
              meta={effectiveMeta}
              selected={selected}
              onSelect={setSelected}
            />
          )}
          {filtered.nodes.length === 0 && (
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
              <p className="text-sm text-zinc-500">
                No resources in {meta.stack}/{stage}
              </p>
              <p className="mt-2 text-[12px] text-zinc-600">
                Deploy the stack first: <code>bun alchemy deploy</code>
              </p>
            </div>
          )}
        </main>
        {selectedNode && (
          <Inspector
            node={selectedNode}
            registry={registry}
            meta={effectiveMeta}
            onClose={() => setSelected(undefined)}
          />
        )}
      </div>
    </div>
  );
}

function Center({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center">
      {children}
    </div>
  );
}
