// DeployTerminal — replays a real `alchemy deploy` run inside a fake terminal.
// Mirrors the Ink CLI in `packages/alchemy/src/Cli/components/{Plan,PlanProgress}.tsx`:
//   • underlined "Plan: N to create" header
//   • plan rows with `+` `~` `-` `!` icons and action colors
//   • progress rows with the same braille spinner used by useGlobalSpinner
//   • status words colored per ApplyStatus
//   • final "✓ deployed in Xs" line + bound URL
// Auto-loops every ~5s of idle.

const { useEffect, useState: useDeployState, useRef: useDeployRef } = React;

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

// Status -> token color (matches statusColor in PlanProgress.tsx)
const STATUS_COLOR = {
  pending:  "var(--alc-code-comment)",  // gray
  creating: "var(--alc-success)",       // green
  created:  "var(--alc-success)",       // green
  updating: "var(--alc-warn)",          // yellow
  updated:  "var(--alc-warn)",          // yellow
  deleting: "var(--alc-danger)",        // red
  deleted:  "var(--alc-danger)",        // red
  fail:     "var(--alc-danger)",
};

// Action -> color/icon (matches getActionColor / getActionIcon in Plan.tsx)
const ACTION_COLOR = {
  create:  "var(--alc-success)",
  update:  "var(--alc-warn)",
  delete:  "var(--alc-danger)",
  replace: "#c4729a",                   // magenta
  noop:    "var(--alc-code-comment)",
};
const ACTION_ICON = { create: "+", update: "~", delete: "-", replace: "!", noop: "•" };

// Static plan we'll animate. Mirrors what the real CLI would print for the
// Stack on the left of the diagram (Bucket + KV + Api with 2 bindings).
const RESOURCES = [
  { id: "Bucket", type: "Cloudflare.R2Bucket",   action: "create", duration: 1200 },
  { id: "KV",     type: "Cloudflare.KVNamespace", action: "create", duration: 900  },
  { id: "Api",    type: "Cloudflare.Worker",     action: "create", duration: 1800,
    bindingCount: 2, startsAfter: ["Bucket", "KV"] },
];

function useSpinner(active, intervalMs = 80) {
  const [i, setI] = useDeployState(0);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setI((v) => (v + 1) % SPINNER_FRAMES.length), intervalMs);
    return () => clearInterval(t);
  }, [active, intervalMs]);
  return SPINNER_FRAMES[i];
}

function DeployTerminal({ title = "~/my-app · alchemy deploy --stage prod", autoplay = true }) {
  // Phase machine. Each phase reveals more of the output.
  //  0: typing the command
  //  1: plan header + plan rows (revealed line by line)
  //  2: progress (each resource transitions pending -> creating -> created on its own timer)
  //  3: success summary
  //  4: rest (then loop)
  const [phase, setPhase] = useDeployState(0);
  const [typed, setTyped] = useDeployState("");
  const [planRowsShown, setPlanRowsShown] = useDeployState(0);
  const [progressStartedAt, setProgressStartedAt] = useDeployState(null);
  const [statuses, setStatuses] = useDeployState({}); // id -> "pending" | "creating" | "created"
  const [elapsedMs, setElapsedMs] = useDeployState(0);
  const containerRef = useDeployRef(null);

  const command = "alchemy deploy --stage prod";

  // PHASE 0: type the command, char by char
  useEffect(() => {
    if (phase !== 0) return;
    setTyped("");
    let i = 0;
    const t = setInterval(() => {
      i += 1;
      setTyped(command.slice(0, i));
      if (i >= command.length) {
        clearInterval(t);
        setTimeout(() => setPhase(1), 350);
      }
    }, 38);
    return () => clearInterval(t);
  }, [phase]);

  // PHASE 1: reveal plan rows one at a time
  useEffect(() => {
    if (phase !== 1) return;
    setPlanRowsShown(0);
    let i = 0;
    const total = RESOURCES.length;
    const t = setInterval(() => {
      i += 1;
      setPlanRowsShown(i);
      if (i >= total) {
        clearInterval(t);
        setTimeout(() => {
          setPhase(2);
          setProgressStartedAt(Date.now());
          setStatuses(Object.fromEntries(RESOURCES.map((r) => [r.id, "pending"])));
        }, 600);
      }
    }, 180);
    return () => clearInterval(t);
  }, [phase]);

  // PHASE 2: drive each resource through pending -> creating -> created on its own schedule
  useEffect(() => {
    if (phase !== 2) return;
    const start = progressStartedAt ?? Date.now();
    const timers = [];
    let staggerOffset = 0;
    const finishTimes = {};
    for (const r of RESOURCES) {
      const earliestStart = (r.startsAfter ?? [])
        .map((dep) => finishTimes[dep] ?? 0)
        .reduce((a, b) => Math.max(a, b), 0);
      const startAt = Math.max(staggerOffset, earliestStart);
      const finishAt = startAt + r.duration;
      finishTimes[r.id] = finishAt;
      staggerOffset += 250; // small stagger between starts of independent resources
      timers.push(setTimeout(() => {
        setStatuses((s) => ({ ...s, [r.id]: "creating" }));
      }, startAt));
      timers.push(setTimeout(() => {
        setStatuses((s) => ({ ...s, [r.id]: "created" }));
      }, finishAt));
    }
    const total = Math.max(...Object.values(finishTimes));
    timers.push(setTimeout(() => {
      setElapsedMs(Date.now() - start);
      setPhase(3);
    }, total + 250));
    return () => timers.forEach(clearTimeout);
  }, [phase, progressStartedAt]);

  // PHASE 3 -> 4 -> loop
  useEffect(() => {
    if (phase !== 3 || !autoplay) return;
    const t = setTimeout(() => setPhase(4), 4500);
    return () => clearTimeout(t);
  }, [phase, autoplay]);

  useEffect(() => {
    if (phase !== 4) return;
    const t = setTimeout(() => {
      setTyped("");
      setPlanRowsShown(0);
      setStatuses({});
      setElapsedMs(0);
      setProgressStartedAt(null);
      setPhase(0);
    }, 700);
    return () => clearTimeout(t);
  }, [phase]);

  const anyInProgress = Object.values(statuses).some((s) => s === "creating");
  const spinner = useSpinner(anyInProgress);

  // ── Render ──────────────────────────────────────────────────────────────
  const Line = ({ children, style }) => (
    <div style={{ minHeight: "1.6em", whiteSpace: "pre", ...style }}>{children}</div>
  );

  const showPlan      = phase >= 1;
  const showProgress  = phase >= 2;
  const showSummary   = phase >= 3;

  return (
    <div ref={containerRef} style={{
      background: "var(--alc-bg-code)",
      border: "1px solid var(--alc-hairline)",
      borderRadius: 10, overflow: "hidden",
      boxShadow: "var(--alc-shadow-sm)",
      fontFamily: "var(--alc-font-mono)",
    }}>
      <div style={{
        display: "flex", alignItems: "center", gap: 6,
        padding: "10px 14px",
        borderBottom: "1px solid rgba(232,220,192,0.08)",
        background: "rgba(255,255,255,0.02)",
      }}>
        <span style={{ width: 10, height: 10, borderRadius: "50%", background: "var(--alc-danger)" }} />
        <span style={{ width: 10, height: 10, borderRadius: "50%", background: "var(--alc-warn)" }} />
        <span style={{ width: 10, height: 10, borderRadius: "50%", background: "var(--alc-accent-bright)" }} />
        <span style={{ marginLeft: 10, fontSize: 11, color: "var(--alc-code-comment)" }}>
          {title}
        </span>
      </div>

      <div style={{
        padding: "16px 18px", fontSize: 12.5, lineHeight: 1.7,
        color: "var(--alc-code-var)", minHeight: 280,
      }}>
        {/* Command line */}
        <Line>
          <span style={{ color: "var(--alc-code-comment)" }}>$ </span>
          {typed}
          {phase === 0 && <span style={{ color: "var(--alc-fg-invert)" }}>▍</span>}
        </Line>

        {/* Plan section */}
        {showPlan && (
          <>
            <Line> </Line>
            <Line>
              <span style={{ textDecoration: "underline", color: "var(--alc-fg-invert)" }}>Plan</span>
              <span>: </span>
              <span style={{ color: ACTION_COLOR.create }}>{RESOURCES.length} to create</span>
            </Line>
            <Line> </Line>
            {RESOURCES.slice(0, planRowsShown).map((r) => (
              <PlanRow key={`plan-${r.id}`} r={r} />
            ))}
          </>
        )}

        {/* Progress section — same rows, but reactive to status */}
        {showProgress && (
          <>
            <Line> </Line>
            {RESOURCES.map((r) => {
              const status = statuses[r.id] ?? "pending";
              const isDone = status === "created" || status === "updated" || status === "deleted";
              const isPending = status === "pending";
              const icon = isDone ? "✓" : isPending ? " " : spinner;
              const color = STATUS_COLOR[status];
              return (
                <ProgressRow
                  key={`prog-${r.id}`}
                  r={r}
                  icon={icon}
                  iconColor={color}
                  status={status}
                />
              );
            })}
          </>
        )}

        {/* Success summary */}
        {showSummary && (
          <>
            <Line> </Line>
            <Line>
              <span style={{ color: "var(--alc-success)" }}>✓ </span>
              <span>deployed in </span>
              <span style={{ color: "var(--alc-fg-invert)", fontWeight: 600 }}>
                {(elapsedMs / 1000).toFixed(1)}s
              </span>
            </Line>
            <Line>
              <span style={{ color: "var(--alc-code-comment)" }}>{"  → "}</span>
              <span style={{ color: "var(--alc-success)" }}>https://api.my-app.workers.dev</span>
            </Line>
          </>
        )}
      </div>
    </div>
  );
}

function PlanRow({ r }) {
  const color = ACTION_COLOR[r.action];
  const icon = ACTION_ICON[r.action];
  return (
    <div style={{ minHeight: "1.6em", whiteSpace: "pre" }}>
      <span style={{ color, width: "1.2em", display: "inline-block" }}>{icon}</span>
      <span style={{ color: "var(--alc-fg-invert)", fontWeight: 600 }}>{r.id}</span>
      <span style={{ color: "var(--alc-code-comment)" }}>{` (${r.type})`}</span>
      {r.bindingCount > 0 && (
        <span style={{ color: "var(--alc-code-type)" }}>{` (${r.bindingCount} bindings)`}</span>
      )}
    </div>
  );
}

function ProgressRow({ r, icon, iconColor, status }) {
  return (
    <div style={{ minHeight: "1.6em", whiteSpace: "pre" }}>
      <span style={{ color: iconColor, width: "1.2em", display: "inline-block" }}>{icon}</span>
      <span style={{ color: "var(--alc-fg-invert)", fontWeight: 600 }}>{r.id}</span>
      <span style={{ color: "var(--alc-code-comment)" }}>{` (${r.type})`}</span>
      <span style={{ color: iconColor }}>{` ${status}`}</span>
    </div>
  );
}

Object.assign(window, { DeployTerminal });
