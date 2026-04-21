import { useEffect, useRef, useState } from "react";
import { Line, sleep, TermChrome, useSpinner } from "./_terminal";

type Phase = "open" | "deploy" | "comment" | "destroy";

const PHASES: { id: Phase; label: string }[] = [
  { id: "open", label: "PR opened" },
  { id: "deploy", label: "Deploy" },
  { id: "comment", label: "Comment" },
  { id: "destroy", label: "Merged & destroyed" },
];

const RESOURCES = [
  { id: "Photos", type: "Cloudflare.R2Bucket" },
  { id: "Sessions", type: "Cloudflare.KVNamespace" },
  { id: "Api", type: "Cloudflare.Worker" },
];

const PR_NUMBER = 147;
const STAGE = `pr-${PR_NUMBER}`;
const PREVIEW_URL = `https://${STAGE}.api.example.workers.dev`;

export default function PRLifecycle() {
  const [phase, setPhase] = useState<Phase>("open");
  const [cmd, setCmd] = useState("");
  const [caret, setCaret] = useState(false);
  const [rows, setRows] = useState<{ id: string; type: string; status: "ready" | "creating" | "created" | "deleting" | "deleted" }[]>([]);
  const [done, setDone] = useState<{ verb: string; secs: string } | null>(null);

  const cancelRef = useRef(false);

  useEffect(() => {
    cancelRef.current = false;
    const aborted = () => cancelRef.current;

    const typeCmd = async (text: string) => {
      setCmd("");
      setCaret(true);
      for (let i = 1; i <= text.length; i++) {
        if (aborted()) return;
        setCmd(text.slice(0, i));
        await sleep(28 + Math.random() * 22);
      }
      await sleep(140);
      setCaret(false);
    };

    const updateRow = (id: string, status: typeof rows[number]["status"]) =>
      setRows((rs) => rs.map((r) => (r.id === id ? { ...r, status } : r)));

    const run = async () => {
      while (!aborted()) {
        // Frame 1: PR opened
        setPhase("open");
        setCmd("");
        setCaret(false);
        setRows([]);
        setDone(null);
        await sleep(2200);
        if (aborted()) return;

        // Frame 2: deploy
        setPhase("deploy");
        await typeCmd(`alchemy deploy --stage ${STAGE}`);
        if (aborted()) return;
        await sleep(220);
        setRows(RESOURCES.map((r) => ({ ...r, status: "ready" })));
        await sleep(260);
        const t0 = Date.now();
        for (const r of RESOURCES) {
          if (aborted()) return;
          updateRow(r.id, "creating");
          await sleep(560);
          if (aborted()) return;
          updateRow(r.id, "created");
          await sleep(120);
        }
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        setDone({ verb: "deployed", secs: elapsed });
        await sleep(900);
        if (aborted()) return;

        // Frame 3: comment posted
        setPhase("comment");
        await sleep(2600);
        if (aborted()) return;

        // Frame 4: merged → destroy
        setPhase("destroy");
        setCmd("");
        setDone(null);
        await sleep(700);
        await typeCmd(`alchemy destroy --stage ${STAGE}`);
        if (aborted()) return;
        await sleep(160);
        const tD = Date.now();
        for (const r of [...RESOURCES].reverse()) {
          if (aborted()) return;
          updateRow(r.id, "deleting");
          await sleep(380);
          if (aborted()) return;
          updateRow(r.id, "deleted");
          await sleep(80);
        }
        const elapsedD = ((Date.now() - tD) / 1000).toFixed(1);
        setDone({ verb: "destroyed", secs: elapsedD });
        await sleep(2400);
      }
    };

    run();
    return () => {
      cancelRef.current = true;
    };
  }, []);

  const anyInFlight = rows.some((r) => r.status === "creating" || r.status === "deleting");
  const spinner = useSpinner(anyInFlight);

  const accent =
    phase === "destroy" ? "var(--alc-danger)" : "var(--alc-accent-bright)";
  const badge =
    phase === "open"
      ? "PR OPENED"
      : phase === "deploy"
        ? "DEPLOY"
        : phase === "comment"
          ? "PREVIEW LIVE"
          : "DESTROY";

  return (
    <div className="pr-lc">
      <ol className="pr-lc__timeline" aria-label="PR lifecycle">
        {PHASES.map((p, i) => {
          const activeIdx = PHASES.findIndex((x) => x.id === phase);
          const state = i < activeIdx ? "done" : i === activeIdx ? "active" : "todo";
          return (
            <li key={p.id} className={`pr-lc__step pr-lc__step--${state}`}>
              <span className="pr-lc__step-num">{i + 1}</span>
              <span className="pr-lc__step-label">{p.label}</span>
            </li>
          );
        })}
      </ol>

      <div className="pr-lc__stage">
        {/* LEFT: PR card */}
        <div className="pr-lc__pr">
          <div className="pr-lc__pr-head">
            <span className={`pr-lc__pr-pill pr-lc__pr-pill--${phase === "destroy" ? "merged" : "open"}`}>
              {phase === "destroy" ? (
                <>
                  <span aria-hidden>⬣</span> Merged
                </>
              ) : (
                <>
                  <span aria-hidden>◍</span> Open
                </>
              )}
            </span>
            <span className="pr-lc__pr-num">#{PR_NUMBER}</span>
          </div>
          <div className="pr-lc__pr-title">Add image upload to /photos</div>
          <div className="pr-lc__pr-meta">
            <span className="pr-lc__pr-branch">feature/photo-upload</span>
            <span className="pr-lc__pr-sep">→</span>
            <span className="pr-lc__pr-branch pr-lc__pr-branch--base">main</span>
          </div>
          <div className="pr-lc__pr-checks">
            <div className={`pr-lc__check ${phase === "open" ? "pr-lc__check--running" : "pr-lc__check--done"}`}>
              <span className="pr-lc__check-dot" />
              <span>Deploy preview</span>
              {phase === "open" ? (
                <span className="pr-lc__check-status">queued</span>
              ) : (
                <span className="pr-lc__check-status">success</span>
              )}
            </div>
            {(phase === "comment" || phase === "destroy") && (
              <div className="pr-lc__check pr-lc__check--done">
                <span className="pr-lc__check-dot" />
                <span>alchemy-bot commented</span>
                <span className="pr-lc__check-status">just now</span>
              </div>
            )}
          </div>
        </div>

        {/* RIGHT: terminal OR github comment, depending on phase */}
        <div className="pr-lc__panel">
          {phase === "comment" ? (
            <div className="gh-mock pr-lc__gh">
              <div className="gh-mock__head">
                <div className="gh-mock__avatar">a</div>
                <div className="gh-mock__author">
                  <strong>alchemy-bot</strong>
                  <span className="gh-mock__bot-tag">bot</span>
                  <span className="gh-mock__meta">commented just now</span>
                </div>
              </div>
              <div className="gh-mock__body">
                <h3 className="gh-mock__h3">Preview Deployed</h3>
                <p className="gh-mock__p">
                  <strong>URL:</strong>{" "}
                  <a href="#" className="gh-mock__url" onClick={(e) => e.preventDefault()}>
                    {PREVIEW_URL}
                  </a>
                </p>
                <p className="gh-mock__p">
                  Built from commit <code className="gh-mock__code">a8f3d21</code>
                </p>
                <hr className="gh-mock__hr" />
                <p className="gh-mock__small">
                  <em>This comment updates automatically with each push.</em>
                </p>
              </div>
            </div>
          ) : (
            <TermChrome title={`ci · ${STAGE}`} badge={badge} badgeColor={accent} bodyMinHeight={232}>
              <Line>
                <span style={{ color: accent }}>$ </span>
                {cmd}
                {caret && <span style={{ color: "var(--alc-fg-invert)" }}>▍</span>}
              </Line>
              {phase === "open" && (
                <>
                  <Line> </Line>
                  <Line>
                    <span style={{ color: "var(--alc-code-comment)" }}>
                      {`# pull_request opened — STAGE=${STAGE}`}
                    </span>
                  </Line>
                  <Line>
                    <span style={{ color: "var(--alc-code-comment)" }}>
                      # workflow queued…
                    </span>
                  </Line>
                </>
              )}
              {rows.length > 0 && (
                <>
                  <Line> </Line>
                  {rows.map((r) => {
                    const isInFlight = r.status === "creating" || r.status === "deleting";
                    const isDone = r.status === "created" || r.status === "deleted";
                    const icon = isInFlight ? spinner : isDone ? "✓" : phase === "destroy" ? "-" : "+";
                    return (
                      <Line key={r.id}>
                        <span
                          style={{
                            color: accent,
                            width: "1.2em",
                            display: "inline-block",
                          }}
                        >
                          {icon}
                        </span>
                        <span style={{ color: "var(--alc-fg-invert)", fontWeight: 600 }}>
                          {r.id}
                        </span>
                        <span style={{ color: "var(--alc-code-comment)" }}>
                          {` (${r.type})`}
                        </span>
                        {isInFlight && (
                          <span style={{ color: accent, marginLeft: 6 }}>{r.status}</span>
                        )}
                      </Line>
                    );
                  })}
                </>
              )}
              {done && (
                <>
                  <Line> </Line>
                  <Line>
                    <span style={{ color: accent }}>✓ </span>
                    <span>{done.verb} in </span>
                    <span style={{ color: "var(--alc-fg-invert)", fontWeight: 600 }}>
                      {done.secs}s
                    </span>
                  </Line>
                  {phase === "deploy" && (
                    <Line>
                      <span style={{ color: "var(--alc-code-comment)" }}>{"  → "}</span>
                      <span style={{ color: accent }}>{PREVIEW_URL}</span>
                    </Line>
                  )}
                </>
              )}
            </TermChrome>
          )}
        </div>
      </div>
    </div>
  );
}
