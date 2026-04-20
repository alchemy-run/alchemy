// LifecycleTerminal — replays the full alchemy lifecycle inside a fake terminal.
//
// It cycles through three commands, with a single shared list of resources
// that transforms in place rather than re-printing:
//
//   1. alchemy plan      — accent CYAN   — rows appear with `+` icons
//   2. alchemy deploy    — accent GREEN  — same rows spin → ✓ created
//   3. alchemy destroy   — accent RED    — rows flip to `-` then spin → ✓ deleted
//
// Spinner frames, action icons, and status colors mirror the real Ink CLI in
// packages/alchemy/src/Cli/components/{Plan,PlanProgress}.tsx.

const { useEffect, useState: useDA, useRef: useDARef } = React;

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

// Action -> icon (Plan.tsx getActionIcon)
const ACTION_ICON = { create: "+", update: "~", delete: "-", replace: "!", noop: "•" };
// Action -> color
const ACTION_COLOR = {
  create:  "var(--alc-success)",
  update:  "var(--alc-warn)",
  delete:  "var(--alc-danger)",
  replace: "#c4729a",
};
// Per-mode accent (the prompt $, the underlined verb, the mode badge).
// Animated via CSS transition so the swap between commands feels intentional.
const MODE_ACCENT = {
  idle:    "var(--alc-code-comment)",
  plan:    "var(--alc-code-type)",      // cyan / sky
  deploy:  "var(--alc-accent-bright)",  // moss / spring green
  destroy: "var(--alc-danger)",         // brick red
};
const MODE_LABEL = {
  plan: "PLAN", deploy: "DEPLOY", destroy: "DESTROY",
};

// The lifecycle subject. Static — only its display state mutates as the
// timeline ticks through plan/deploy/destroy. Bindings render as nested
// children under their owning resource (matching the real CLI plan output).
const RESOURCES = [
  {
    id: "Api", type: "Cloudflare.Worker",
    bindings: ["Bucket", "Queue"],
  },
  { id: "Bucket", type: "Cloudflare.R2Bucket", bindings: [] },
  { id: "Queue",  type: "Cloudflare.Queue",    bindings: [] },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function useSpinner(active, intervalMs = 80) {
  const [i, setI] = useDA(0);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setI((v) => (v + 1) % SPINNER_FRAMES.length), intervalMs);
    return () => clearInterval(t);
  }, [active, intervalMs]);
  return SPINNER_FRAMES[i];
}

function LifecycleTerminal({ title = "~/my-app" }) {
  // Whole-terminal state
  const [mode, setMode]         = useDA("idle");          // "idle" | "plan" | "deploy" | "destroy"
  const [cmd, setCmd]           = useDA("");              // currently visible command after the $
  const [caret, setCaret]       = useDA(false);           // blinking caret while typing
  const [header, setHeader]     = useDA(null);            // { verb, count, action } | null
  const [rows, setRows]         = useDA([]);              // [{ id, type, action, status, bindings: [] }]
  const [summary, setSummary]   = useDA(null);            // { verb, secs, url? } | null
  const [proceed, setProceed]   = useDA(null);            // null | "show" | "confirmed"

  const cancelRef = useDARef(false);

  // ────────────────────────────────────────────────────────────────────────
  // Timeline. Plays once on mount, loops forever, cancels on unmount.
  // ────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    cancelRef.current = false;
    const aborted = () => cancelRef.current;

    // Helpers (close over setters)
    const typeCmd = async (text) => {
      setCmd(""); setCaret(true);
      for (let i = 1; i <= text.length; i++) {
        if (aborted()) return;
        setCmd(text.slice(0, i));
        await sleep(36 + Math.random() * 24);
      }
      await sleep(180);
      setCaret(false);
    };

    const updateRow = (id, patch) =>
      setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));

    const setAllRowsAction = (action, status = "pending") =>
      setRows((rs) => rs.map((r) => ({ ...r, action, status })));

    const revealRows = async (action, perRowMs = 130) => {
      setRows([]);
      for (const r of RESOURCES) {
        if (aborted()) return;
        setRows((rs) => [...rs, { ...r, action, status: "ready" }]);
        await sleep(perRowMs);
      }
    };

    const startResource = async (id, status, ms) => {
      if (aborted()) return;
      updateRow(id, { status });
      await sleep(ms);
      if (aborted()) return;
      const done = status === "creating" ? "created" : "deleted";
      updateRow(id, { status: done });
    };

    const run = async () => {
      while (!aborted()) {
        // ────────── PLAN ──────────
        setMode("plan");
        setHeader(null); setRows([]); setSummary(null); setProceed(null);
        await typeCmd("alchemy plan");
        if (aborted()) return;
        await sleep(250);
        setHeader({ verb: "Plan", count: RESOURCES.length, action: "create" });
        await sleep(150);
        await revealRows("create");
        await sleep(2400);

        // ────────── DEPLOY ──────────
        if (aborted()) return;
        setMode("deploy");
        setSummary(null);
        await typeCmd("alchemy deploy");
        if (aborted()) return;
        setHeader({ verb: "Apply", count: RESOURCES.length, action: "create" });
        await sleep(300);
        // Show the Proceed? ◉ Yes ○ No prompt briefly
        setProceed("show");
        await sleep(900);
        if (aborted()) return;
        setProceed("confirmed");
        await sleep(450);
        if (aborted()) return;
        setProceed(null);
        // Leaves (Bucket, Queue) in parallel first, then Api once they're done.
        const t0 = Date.now();
        await Promise.all([
          startResource("Bucket", "creating", 1000),
          (async () => { await sleep(220); await startResource("Queue", "creating", 900); })(),
        ]);
        if (aborted()) return;
        await startResource("Api", "creating", 1300);
        if (aborted()) return;
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        setSummary({ verb: "deployed", secs: elapsed, url: "https://api.my-app.workers.dev" });
        await sleep(2600);

        // ────────── DESTROY ──────────
        if (aborted()) return;
        setMode("destroy");
        setSummary(null);
        await typeCmd("alchemy destroy");
        if (aborted()) return;
        setHeader({ verb: "Apply", count: RESOURCES.length, action: "delete" });
        // Flip every row to delete-pending (icon `-`, red), preserving order.
        setAllRowsAction("delete", "ready");
        await sleep(350);
        setProceed("show");
        await sleep(900);
        setProceed("confirmed");
        await sleep(400);
        setProceed(null);
        // Reverse dependency order: Api first, then leaves in parallel.
        const tD = Date.now();
        await startResource("Api", "deleting", 900);
        if (aborted()) return;
        await Promise.all([
          startResource("Bucket", "deleting", 700),
          (async () => { await sleep(180); await startResource("Queue", "deleting", 650); })(),
        ]);
        if (aborted()) return;
        const elapsedD = ((Date.now() - tD) / 1000).toFixed(1);
        setSummary({ verb: "destroyed", secs: elapsedD });
        await sleep(2800);
      }
    };

    run();
    return () => { cancelRef.current = true; };
  }, []);

  const anyInFlight = rows.some((r) => r.status === "creating" || r.status === "deleting");
  const spinner = useSpinner(anyInFlight);

  // ────────────────────────────────────────────────────────────────────────
  // Render
  // ────────────────────────────────────────────────────────────────────────
  const accent = MODE_ACCENT[mode];

  const Line = ({ children, style }) => (
    <div style={{ minHeight: "1.55em", whiteSpace: "pre", ...style }}>{children}</div>
  );

  const renderRow = (r) => {
    const actionColor = ACTION_COLOR[r.action] ?? "var(--alc-code-comment)";
    let icon, iconColor, statusWord, statusColor;
    if (r.status === "ready") {
      icon = ACTION_ICON[r.action];
      iconColor = actionColor;
      statusWord = null;
    } else if (r.status === "creating" || r.status === "deleting") {
      icon = spinner;
      iconColor = actionColor;
      statusWord = r.status;
      statusColor = actionColor;
    } else if (r.status === "created" || r.status === "deleted") {
      icon = "✓";
      iconColor = actionColor;
      statusWord = r.status;
      statusColor = actionColor;
    } else {
      icon = " ";
      iconColor = "transparent";
    }

    const bindingIcon = ACTION_ICON[r.action] ?? "+";
    const bindingCount = r.bindings?.length ?? 0;

    return (
      <div key={r.id}>
        <div style={{
          minHeight: "1.55em", whiteSpace: "pre",
          transition: "opacity 200ms var(--alc-ease, ease)",
        }}>
          <span style={{
            color: iconColor, width: "1.2em", display: "inline-block",
            transition: "color 200ms ease",
          }}>{icon}</span>
          <span style={{ color: "var(--alc-fg-invert)", fontWeight: 600 }}>{r.id}</span>
          <span style={{ color: "var(--alc-code-comment)" }}>{` (${r.type})`}</span>
          {bindingCount > 0 && (
            <span style={{ color: "var(--alc-code-type)" }}>{` (${bindingCount} bindings)`}</span>
          )}
          {statusWord && (
            <span style={{
              color: statusColor, marginLeft: 6,
              transition: "color 200ms ease",
            }}>{statusWord}</span>
          )}
        </div>
        {bindingCount > 0 && r.bindings.map((b) => (
          <div key={`${r.id}-${b}`} style={{ minHeight: "1.55em", whiteSpace: "pre" }}>
            <span style={{ width: "1.2em", display: "inline-block" }}> </span>
            <span style={{
              color: actionColor, width: "1.2em", display: "inline-block",
              transition: "color 200ms ease",
            }}>{bindingIcon}</span>
            <span style={{ color: "var(--alc-code-type)" }}>{b}</span>
          </div>
        ))}
      </div>
    );
  };

  return (
    <div style={{
      background: "var(--alc-bg-code)",
      border: "1px solid var(--alc-hairline)",
      borderRadius: 10, overflow: "hidden",
      boxShadow: "var(--alc-shadow-sm)",
      fontFamily: "var(--alc-font-mono)",
    }}>
      {/* chrome — mac dots, file path, and a mode pill that swaps color per phase */}
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
        <span style={{ flex: 1 }} />
        {mode !== "idle" && (
          <span style={{
            fontSize: 10, letterSpacing: "0.14em", fontWeight: 700,
            padding: "2px 8px", borderRadius: 4,
            color: accent,
            border: `1px solid ${accent}`,
            background: "transparent",
            transition: "color 280ms ease, border-color 280ms ease",
          }}>{MODE_LABEL[mode]}</span>
        )}
      </div>

      <div style={{
        padding: "14px 18px", fontSize: 12.5, lineHeight: 1.65,
        color: "var(--alc-code-var)",
        // sized to match the alchemy.run.ts on the left and big enough to fit
        // the tallest phase (deploy w/ Proceed? + 3 resources + 2 bindings +
        // summary ≈ 13 lines) without text reflow as phases swap.
        minHeight: 296,
      }}>
        {/* prompt + currently-typed command */}
        <Line>
          <span style={{
            color: accent,
            transition: "color 280ms ease",
          }}>$ </span>
          {cmd}
          {caret && <span style={{ color: "var(--alc-fg-invert)" }}>▍</span>}
        </Line>

        {header && (
          <>
            <Line> </Line>
            <Line>
              <span style={{
                textDecoration: "underline",
                color: accent,
                transition: "color 280ms ease",
                fontWeight: 600,
              }}>{header.verb}</span>
              <span>: </span>
              <span style={{ color: ACTION_COLOR[header.action] }}>
                {header.count} to {header.action}
              </span>
            </Line>
          </>
        )}

        {rows.length > 0 && (
          <>
            <Line> </Line>
            {rows.map(renderRow)}
          </>
        )}

        {proceed && (
          <>
            <Line> </Line>
            <Line>Proceed?</Line>
            <Line>
              {proceed === "confirmed" ? (
                <>
                  <span style={{ color: accent, transition: "color 200ms ease" }}>{"◉ Yes "}</span>
                  <span style={{ color: "var(--alc-code-comment)" }}>{"○ No"}</span>
                </>
              ) : (
                <>
                  <span style={{ color: "var(--alc-fg-invert)" }}>{"◉ Yes "}</span>
                  <span style={{ color: "var(--alc-code-comment)" }}>{"○ No"}</span>
                </>
              )}
            </Line>
          </>
        )}

        {summary && (
          <>
            <Line> </Line>
            <Line>
              <span style={{ color: accent, transition: "color 280ms ease" }}>✓ </span>
              <span>{summary.verb} in </span>
              <span style={{ color: "var(--alc-fg-invert)", fontWeight: 600 }}>{summary.secs}s</span>
            </Line>
            {summary.url && (
              <Line>
                <span style={{ color: "var(--alc-code-comment)" }}>{"  → "}</span>
                <span style={{ color: accent, transition: "color 280ms ease" }}>{summary.url}</span>
              </Line>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// Back-compat: anything that imported `DeployTerminal` keeps working.
const DeployTerminal = LifecycleTerminal;

// ---------------------------------------------------------------------------
// TestTerminal — animated `bun test` lifecycle for the integration-tests
// section. Mirrors the static Terminal content that used to live there:
//
//   $ bun test
//   ✓ deploy (3 resources · 4.2s)
//     → https://api.pr-1729.workers.dev
//   ✓ PUT + GET round-trips through R2 (312ms)
//   ✓ Room DO preserves state across requests (184ms)
//   ✓ destroy (3 resources · 1.8s)
//    PASS   2 tests · 10.6s
//
// Each step starts as a spinner and resolves to ✓, so the panel feels alive
// alongside the LifecycleTerminal in the hero.
// ---------------------------------------------------------------------------

const TEST_STAGE = "pr-1729";
const TEST_STEPS = [
  { id: "deploy", kind: "phase",
    label: "deploy", detail: "3 resources",
    runMs: 1100, durSec: "4.2",
    url: `https://api.${TEST_STAGE}.workers.dev` },
  { id: "t1", kind: "test",
    label: "PUT + GET round-trips through R2",
    runMs: 850, durMs: "312" },
  { id: "t2", kind: "test",
    label: "Room DO preserves state across requests",
    runMs: 700, durMs: "184" },
  { id: "destroy", kind: "phase",
    label: "destroy", detail: "3 resources",
    runMs: 900, durSec: "1.8" },
];

function TestTerminal({ title = `CI · ${TEST_STAGE}` }) {
  const [cmd, setCmd]       = useDA("");
  const [caret, setCaret]   = useDA(false);
  const [steps, setSteps]   = useDA([]);   // [{ id, status: "running"|"done", ...meta }]
  const [summary, setSummary] = useDA(null); // { tests, secs } | null

  const cancelRef = useDARef(false);

  useEffect(() => {
    cancelRef.current = false;
    const aborted = () => cancelRef.current;

    const typeCmd = async (text) => {
      setCmd(""); setCaret(true);
      for (let i = 1; i <= text.length; i++) {
        if (aborted()) return;
        setCmd(text.slice(0, i));
        await sleep(36 + Math.random() * 24);
      }
      await sleep(180);
      setCaret(false);
    };

    const run = async () => {
      while (!aborted()) {
        setSteps([]); setSummary(null);
        await typeCmd("bun test");
        if (aborted()) return;
        await sleep(280);

        const t0 = Date.now();
        for (const s of TEST_STEPS) {
          if (aborted()) return;
          setSteps((arr) => [...arr, { ...s, status: "running" }]);
          await sleep(s.runMs);
          if (aborted()) return;
          setSteps((arr) => arr.map((r) => (r.id === s.id ? { ...r, status: "done" } : r)));
          await sleep(160);
        }
        if (aborted()) return;
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        setSummary({ tests: 2, secs: elapsed });
        await sleep(2800);
      }
    };

    run();
    return () => { cancelRef.current = true; };
  }, []);

  const anyRunning = steps.some((s) => s.status === "running");
  const spinner = useSpinner(anyRunning);

  const accent = "var(--alc-accent-bright)"; // green — pass/run
  const Line = ({ children, style }) => (
    <div style={{ minHeight: "1.55em", whiteSpace: "pre", ...style }}>{children}</div>
  );

  const renderStep = (s, idx, arr) => {
    const isRunning = s.status === "running";
    const icon = isRunning ? spinner : "✓";
    const iconColor = isRunning ? "var(--alc-code-type)" : accent;

    if (s.kind === "phase") {
      return (
        <React.Fragment key={s.id}>
          <Line>
            <span style={{ color: iconColor, width: "1.2em", display: "inline-block" }}>{icon}</span>
            <span style={{ color: "var(--alc-fg-invert)", fontWeight: 600 }}>{s.label}</span>
            {!isRunning && (
              <span style={{ color: "var(--alc-code-comment)" }}>
                {` (${s.detail} · ${s.durSec}s)`}
              </span>
            )}
            {isRunning && (
              <span style={{ color: "var(--alc-code-comment)" }}>
                {` (${s.detail})`}
              </span>
            )}
          </Line>
          {s.url && !isRunning && (
            <Line>
              <span style={{ color: "var(--alc-code-comment)" }}>{"  → "}</span>
              <span style={{ color: "var(--alc-code-comment)" }}>{s.url}</span>
            </Line>
          )}
          {/* spacer after deploy block / before destroy summary block */}
          {!isRunning && idx < arr.length - 1 && <Line> </Line>}
        </React.Fragment>
      );
    }

    return (
      <Line key={s.id}>
        <span style={{ color: iconColor, width: "1.2em", display: "inline-block" }}>{icon}</span>
        <span style={{ color: "var(--alc-fg-invert)" }}>{s.label}</span>
        {!isRunning && (
          <span style={{ color: "var(--alc-code-comment)" }}>{` (${s.durMs}ms)`}</span>
        )}
      </Line>
    );
  };

  return (
    <div style={{
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
        <span style={{ flex: 1 }} />
        <span style={{
          fontSize: 10, letterSpacing: "0.14em", fontWeight: 700,
          padding: "2px 8px", borderRadius: 4,
          color: accent, border: `1px solid ${accent}`, background: "transparent",
        }}>TEST</span>
      </div>

      <div style={{
        padding: "14px 18px", fontSize: 12.5, lineHeight: 1.65,
        color: "var(--alc-code-var)",
        minHeight: 232,
      }}>
        <Line>
          <span style={{ color: accent }}>$ </span>
          {cmd}
          {caret && <span style={{ color: "var(--alc-fg-invert)" }}>▍</span>}
        </Line>

        {steps.length > 0 && (
          <>
            <Line> </Line>
            {steps.map((s, i, arr) => renderStep(s, i, arr))}
          </>
        )}

        {summary && (
          <>
            <Line> </Line>
            <Line>
              <span style={{
                background: accent, color: "var(--alc-bg-code)",
                fontWeight: 700, padding: "0 8px", marginRight: 8,
              }}> PASS </span>
              <span>{summary.tests} tests · </span>
              <span style={{ color: "var(--alc-fg-invert)", fontWeight: 600 }}>{summary.secs}s</span>
            </Line>
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// DevTerminal — animated `alchemy dev` showing local emulation with hot
// reload. Tells the story:
//
//   1. boot:   detect resources from the source graph, spin up local emulators
//   2. ready:  print the local URL, start watching the file tree
//   3. edit:   touch src/Api.ts → Api worker hot-reloads in <100ms
//   4. add:    add a Queue resource → detected, created locally, Api rebound
//   5. loop
//
// The narrative is intentionally different from the LifecycleTerminal up-page
// (which is plan → deploy → destroy against the real cloud); this one is
// strictly about the dev loop.
// ---------------------------------------------------------------------------

const DEV_INITIAL = [
  { id: "Bucket", type: "Cloudflare.R2Bucket",    bindings: [] },
  { id: "KV",     type: "Cloudflare.KVNamespace", bindings: [] },
  { id: "Api",    type: "Cloudflare.Worker",      bindings: ["Bucket", "KV"] },
];

function DevTerminal({ title = "~/my-app" }) {
  const [cmd, setCmd]       = useDA("");
  const [caret, setCaret]   = useDA(false);
  const [rows, setRows]     = useDA([]);   // [{ id, type, bindings, status, lastMs?, isNew? }]
  const [url, setUrl]       = useDA(null); // local URL line
  const [events, setEvents] = useDA([]);   // scrolling change-feed entries

  const cancelRef = useDARef(false);

  useEffect(() => {
    cancelRef.current = false;
    const aborted = () => cancelRef.current;

    const typeCmd = async (text) => {
      setCmd(""); setCaret(true);
      for (let i = 1; i <= text.length; i++) {
        if (aborted()) return;
        setCmd(text.slice(0, i));
        await sleep(36 + Math.random() * 24);
      }
      await sleep(180);
      setCaret(false);
    };

    const updateRow = (id, patch) =>
      setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));

    const pushEvent = (ev) =>
      setEvents((es) => {
        const next = [...es, ev];
        return next.length > 4 ? next.slice(next.length - 4) : next;
      });

    const startResource = async (id, status, ms) => {
      if (aborted()) return;
      updateRow(id, { status });
      await sleep(ms);
      if (aborted()) return;
      updateRow(id, { status: "ready", lastMs: ms });
    };

    const run = async () => {
      while (!aborted()) {
        // ────────── BOOT ──────────
        setRows([]); setUrl(null); setEvents([]);
        await typeCmd("alchemy dev");
        if (aborted()) return;
        await sleep(360);

        // Reveal each resource as detected, then spin → ready in parallel-ish
        for (const r of DEV_INITIAL) {
          if (aborted()) return;
          setRows((rs) => [...rs, { ...r, status: "detected" }]);
          await sleep(160);
        }
        await sleep(220);
        if (aborted()) return;

        await Promise.all([
          startResource("Bucket", "starting", 700),
          (async () => { await sleep(140); await startResource("KV", "starting", 620); })(),
          (async () => { await sleep(320); await startResource("Api", "starting", 950); })(),
        ]);
        if (aborted()) return;

        setUrl("http://localhost:1337");
        pushEvent({ kind: "ready", text: "ready in 1.2s · watching for changes" });
        await sleep(1800);

        // ────────── EDIT: Api.ts changed → hot reload ──────────
        if (aborted()) return;
        pushEvent({ kind: "change", text: "~ src/Api.ts changed" });
        updateRow("Api", { status: "reloading" });
        await sleep(620);
        if (aborted()) return;
        updateRow("Api", { status: "ready", lastMs: 84 });
        pushEvent({ kind: "reload", text: "↻ Api hot-reloaded in 84ms" });
        await sleep(1700);

        // ────────── ADD: new Queue resource detected ──────────
        if (aborted()) return;
        pushEvent({ kind: "change", text: "+ src/Queue.ts added" });
        await sleep(280);
        setRows((rs) => [
          ...rs,
          { id: "Queue", type: "Cloudflare.Queue", bindings: [], status: "detected", isNew: true },
        ]);
        await sleep(280);
        if (aborted()) return;
        await startResource("Queue", "starting", 720);
        if (aborted()) return;

        // Api picks up the new binding
        updateRow("Api", { bindings: ["Bucket", "KV", "Queue"], status: "reloading" });
        pushEvent({ kind: "rebind", text: "↻ Api rebinding (+1 binding)" });
        await sleep(620);
        if (aborted()) return;
        updateRow("Api", { status: "ready", lastMs: 92 });
        pushEvent({ kind: "reload", text: "↻ Api hot-reloaded in 92ms" });
        await sleep(2600);
      }
    };

    run();
    return () => { cancelRef.current = true; };
  }, []);

  const anyInFlight = rows.some(
    (r) => r.status === "starting" || r.status === "reloading"
  );
  const spinner = useSpinner(anyInFlight);

  const accent = "var(--alc-accent-bright)"; // green — the "running / live" mode

  const Line = ({ children, style }) => (
    <div style={{ minHeight: "1.55em", whiteSpace: "pre", ...style }}>{children}</div>
  );

  const renderRow = (r) => {
    let icon, iconColor, statusWord, statusColor;
    if (r.status === "detected") {
      icon = "+"; iconColor = "var(--alc-success)";
    } else if (r.status === "starting") {
      icon = spinner; iconColor = "var(--alc-success)";
      statusWord = "starting"; statusColor = "var(--alc-success)";
    } else if (r.status === "reloading") {
      icon = spinner; iconColor = "var(--alc-warn)";
      statusWord = "reloading"; statusColor = "var(--alc-warn)";
    } else if (r.status === "ready") {
      icon = "✓"; iconColor = accent;
      statusWord = r.lastMs ? `ready · ${r.lastMs}ms` : "ready (local)";
      statusColor = "var(--alc-code-comment)";
    } else {
      icon = " "; iconColor = "transparent";
    }
    const bcount = r.bindings?.length ?? 0;
    return (
      <Line key={r.id} style={{ transition: "opacity 200ms ease" }}>
        <span style={{ color: iconColor, width: "1.2em", display: "inline-block",
          transition: "color 200ms ease" }}>{icon}</span>
        <span style={{ color: "var(--alc-fg-invert)", fontWeight: 600 }}>{r.id}</span>
        <span style={{ color: "var(--alc-code-comment)" }}>{` (${r.type})`}</span>
        {bcount > 0 && (
          <span style={{ color: "var(--alc-code-type)" }}>{` (${bcount} bindings)`}</span>
        )}
        {statusWord && (
          <span style={{ color: statusColor, marginLeft: 6,
            transition: "color 200ms ease" }}>{statusWord}</span>
        )}
        {r.isNew && r.status !== "ready" && (
          <span style={{ color: "var(--alc-success)", marginLeft: 6, fontStyle: "italic" }}>
            new
          </span>
        )}
      </Line>
    );
  };

  const renderEvent = (e, i) => {
    const colorByKind = {
      info:   "var(--alc-code-comment)",
      change: "var(--alc-warn)",
      reload: "var(--alc-accent-bright)",
      rebind: "var(--alc-warn)",
      ready:  "var(--alc-accent-bright)",
    };
    return (
      <Line key={`${i}-${e.text}`}>
        <span style={{ color: colorByKind[e.kind] || "var(--alc-code-comment)" }}>
          {e.text}
        </span>
      </Line>
    );
  };

  return (
    <div style={{
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
        <span style={{ flex: 1 }} />
        <span style={{
          fontSize: 10, letterSpacing: "0.14em", fontWeight: 700,
          padding: "2px 8px", borderRadius: 4,
          color: accent, border: `1px solid ${accent}`, background: "transparent",
        }}>DEV</span>
      </div>

      <div style={{
        padding: "14px 18px", fontSize: 12.5, lineHeight: 1.65,
        color: "var(--alc-code-var)",
        minHeight: 332,
      }}>
        <Line>
          <span style={{ color: accent }}>$ </span>
          {cmd}
          {caret && <span style={{ color: "var(--alc-fg-invert)" }}>▍</span>}
        </Line>

        {rows.length > 0 && (
          <>
            <Line> </Line>
            {rows.map(renderRow)}
          </>
        )}

        {url && (
          <>
            <Line> </Line>
            <Line>
              <span style={{ color: "var(--alc-code-comment)" }}>{"  → "}</span>
              <span style={{ color: accent }}>{url}</span>
            </Line>
          </>
        )}

        {events.length > 0 && (
          <>
            <Line> </Line>
            {events.map(renderEvent)}
          </>
        )}
      </div>
    </div>
  );
}

Object.assign(window, { LifecycleTerminal, DeployTerminal, TestTerminal, DevTerminal });
