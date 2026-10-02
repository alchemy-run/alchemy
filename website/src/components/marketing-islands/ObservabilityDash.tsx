import { useEffect, useState } from "react";
import { highlightTS } from "../marketing/highlightTS";
import "./ObservabilityDash.css";

/*
 * The observability section: the Worker providing the Observability Layer,
 * the Layer itself, and a mock of the dashboard it creates (the talk deck's
 * Dash.tsx, for the Photos app). The loop plays live traffic, an error
 * spike, and the monitor firing; the Layer's code lights the line that
 * created whatever is on screen.
 *
 * The dashboard is a hypothetical UI, and says so.
 */

const API_SRC = `export default Cloudflare.Worker(
  "Api",
  { main: import.meta.url },
  Effect.gen(function* () {
    const photos = yield* Photos;
    return { fetch: handler };
  }).pipe(
    Effect.provide([PhotosR2, Observability]),
  ),
);`;

const LAYER_SRC = `export const Observability = Layer.unwrap(
  Effect.gen(function* () {
    const traces = yield* Axiom.Dataset("Traces", tracesProps);
    const logs = yield* Axiom.Dataset("Logs", logsProps);
    const token = yield* Axiom.ApiToken("Ingest", ingestProps);

    yield* Axiom.Dashboard("Dashboard", dashboardProps);
    yield* Axiom.Monitor("Errors", errorRateProps);

    return Axiom.Telemetry({ token, traces, logs });
  }),
);`;

// 0-based lines of LAYER_SRC lit in each phase.
const LIT = {
  traces: [2, 3, 4, 9],
  dashboard: [6],
  monitor: [7],
} as const;
// 0-based line of API_SRC that provides the Layer.
const API_PROVIDE = 7;

const T_DASH = 3000;
const T_SPIKE = 5600;
const T_ALERT = 7000;
const T_RECOVER = 10800;
const LOOP_MS = 12800;
const TICK_MS = 260;
const POINTS = 44;

const noise = (i: number, seed: number) => {
  const x = Math.sin(i * 12.9898 + seed * 78.233) * 43758.5453;
  return x - Math.floor(x);
};
const req = (i: number) => 60 + 22 * Math.sin(i / 6) + 16 * noise(i, 1);
const err = (i: number, spikeFrom: number) =>
  i >= spikeFrom
    ? Math.min(30, 13 + 9 * noise(i, 3) + (i - spikeFrom) * 1.5)
    : 1.5 * noise(i, 2);

const TRACES: [string, number][] = [
  ["PUT /photos/cat.jpg", 48],
  ["GET /photos", 12],
  ["PUT /photos/dog.png", 52],
  ["GET /photos/cat.jpg", 9],
  ["PUT /photos/sun.jpg", 44],
  ["GET /photos", 14],
];

const isPaused = () =>
  document.documentElement.classList.contains("alc-motion-paused") ||
  matchMedia("(prefers-reduced-motion: reduce)").matches;

function Code({
  file,
  src,
  lit,
}: {
  file: string;
  src: string;
  lit: readonly number[];
}) {
  return (
    <div className="od-code">
      <div className="od-code__head">{file}</div>
      <pre className="od-code__pre">
        {src.split("\n").map((line, i) => (
          <span
            key={i}
            className={`od-code__line ${lit.includes(i) ? "is-lit" : ""}`}
            dangerouslySetInnerHTML={{ __html: highlightTS(line) || " " }}
          />
        ))}
      </pre>
    </div>
  );
}

function Chart({
  title,
  values,
  max,
  color,
  threshold,
  alerting,
}: {
  title: string;
  values: number[];
  max: number;
  color: string;
  threshold?: number;
  alerting?: boolean;
}) {
  const W = 300;
  const H = 96;
  const px = (i: number) => (i / (values.length - 1)) * W;
  const py = (v: number) => H - (v / max) * H;
  const d = values
    .map((v, i) => `${i ? "L" : "M"}${px(i).toFixed(1)} ${py(v).toFixed(1)}`)
    .join(" ");
  return (
    <div className={`od-panel ${alerting ? "is-alerting" : ""}`}>
      <div className="od-panel__title">
        {title}
        <span className="od-panel__value" style={{ color }}>
          {Math.round(values[values.length - 1]!)}
        </span>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="od-chart"
      >
        {[0.25, 0.5, 0.75].map((f) => (
          <line
            key={f}
            x1={0}
            x2={W}
            y1={H * f}
            y2={H * f}
            className="od-grid"
          />
        ))}
        {threshold !== undefined && (
          <line
            x1={0}
            x2={W}
            y1={py(threshold)}
            y2={py(threshold)}
            className="od-threshold"
          />
        )}
        <path d={`${d} L${W} ${H} L0 ${H} Z`} fill={color} opacity={0.14} />
        <path
          d={d}
          fill="none"
          stroke={color}
          strokeWidth={2}
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      {threshold !== undefined && (
        <div className="od-panel__note">threshold {threshold}</div>
      )}
    </div>
  );
}

export default function ObservabilityDash() {
  // A still frame (the monitor firing) until the loop starts.
  const [t, setT] = useState(T_ALERT + 800);

  useEffect(() => {
    let paused = isPaused();
    let last = performance.now();
    let elapsed = 0;
    const onMotion = () => {
      paused = isPaused();
    };
    addEventListener("alc-motion-change", onMotion);
    const id = setInterval(() => {
      const now = performance.now();
      if (!paused) {
        elapsed = (elapsed + now - last) % LOOP_MS;
        setT(elapsed);
      }
      last = now;
    }, 80);
    return () => {
      clearInterval(id);
      removeEventListener("alc-motion-change", onMotion);
    };
  }, []);

  const tick = Math.floor(t / TICK_MS);
  const spiking = t >= T_SPIKE && t < T_RECOVER;
  const alerting = t >= T_ALERT && t < T_RECOVER;
  // The spike starts at the right edge and scrolls left as time passes.
  const spikeFrom = spiking
    ? tick + POINTS - Math.floor((t - T_SPIKE) / TICK_MS) - 1
    : Infinity;
  const window = Array.from({ length: POINTS }, (_, k) => tick + k);
  const requests = window.map(req);
  const errors = window.map((i) => err(i, spikeFrom));

  const phase = t < T_DASH ? "traces" : t < T_ALERT ? "dashboard" : "monitor";
  const traceCount = Math.min(TRACES.length, 1 + Math.floor(t / 600));
  const traces = TRACES.slice(0, traceCount).map(([name, ms], i) => {
    const failed = spiking && name.startsWith("PUT") && i >= 2;
    return { name, ms, failed };
  });

  return (
    <div className="od" aria-hidden>
      <div className="od-codes">
        <Code file="src/api.ts" src={API_SRC} lit={[API_PROVIDE]} />
        <Code file="src/Observability.ts" src={LAYER_SRC} lit={LIT[phase]} />
      </div>

      <div className="od-dash">
        <div className="od-dash__head">
          <strong>my-app</strong>
          <span className="od-muted">dashboard · last 1h · traces</span>
          <span className="od-dash__live">
            <span className="od-dash__dot" /> live
          </span>
          <span className="od-muted od-dash__mock">hypothetical UI</span>
        </div>
        <div className="od-dash__grid">
          <Chart
            title="Requests / min"
            values={requests}
            max={110}
            color="var(--od-line)"
          />
          <Chart
            title="Errors / min"
            values={errors}
            max={34}
            color="var(--od-error)"
            threshold={10}
            alerting={alerting}
          />

          <div className={`od-panel ${phase === "traces" ? "is-focus" : ""}`}>
            <div className="od-panel__title">Recent traces</div>
            <ul className="od-traces">
              {traces.map((tr) => (
                <li
                  key={tr.name + tr.ms}
                  className={tr.failed ? "is-failed" : ""}
                >
                  <span className="od-traces__name">{tr.name}</span>
                  <span
                    className="od-traces__bar"
                    style={{ width: `${Math.max(6, tr.ms * 1.6)}px` }}
                  />
                  <span className="od-traces__ms">
                    {tr.failed ? "500" : `${tr.ms} ms`}
                  </span>
                </li>
              ))}
            </ul>
          </div>

          <div
            className={`od-panel od-panel--monitor ${alerting ? "is-alerting" : ""} ${phase === "monitor" ? "is-focus" : ""}`}
          >
            <div className="od-panel__title">Monitors</div>
            <div className="od-monitor">
              <span className={`od-monitor__dot ${alerting ? "is-red" : ""}`} />
              <strong>Photos errors</strong>
              <span className={`od-monitor__state ${alerting ? "is-red" : ""}`}>
                {alerting ? "ALERTING" : "OK"}
              </span>
            </div>
            <div className="od-muted od-monitor__rule">
              count(error) above 10 · every 5 min
            </div>
            {alerting ? (
              <div className="od-monitor__detail">
                <div className="od-red">27 errors in the last 5 min</div>
                <div className="od-muted">
                  top span: Photos.upload · R2 timeout
                </div>
              </div>
            ) : (
              <div className="od-monitor__detail od-muted">
                last fired: never
              </div>
            )}
            <div className={`od-toast ${alerting ? "is-shown" : ""}`}>
              <strong>● Monitor fired: Photos errors</strong>
              <span>→ sent to the agent: Photos.upload failing</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
