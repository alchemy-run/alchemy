import { useEffect, useRef, useState } from "react";
import { RollTemplate } from "./_roll";
import { Line, prefersReducedMotion, sleep, TermChrome, useSpinner } from "./_terminal";
import {
  compactValues,
  HOST_TEMPLATE,
  HOST_TEMPLATE_COMPACT,
  HOSTS,
  type HostResource,
} from "./heroHosts";
import "./HeroHosts.css";

/*
 * The hero: one model cycling through the platforms that can host it. Each
 * turn rolls the Layer that changes the way the talk deck's Roll does, then
 * runs the tests and deploys it, showing the resources that platform needs.
 * Clicking a platform in the reel jumps to it.
 */

type Status = "ready" | "creating" | "created";
type Row = HostResource & { status: Status };

const GREEN = "var(--alc-accent-bright)";
const CREATE = "var(--alc-success)";
const SEGMENTS = HOST_TEMPLATE.split(/⟨(\d)⟩/);
const SEGMENTS_COMPACT = HOST_TEMPLATE_COMPACT.split(/⟨(\d)⟩/);
const ROLL_MS = 450;

export default function HeroHosts() {
  const [host, setHost] = useState(0);
  const [start, setStart] = useState<{ at: number; key: number }>({
    at: 0,
    key: 0,
  });
  // The deck's roll: changed values slide up out of their slot while the
  // new ones slide in, and the slot's width eases between the two.
  const [roll, setRoll] = useState<{
    was: readonly string[];
    now: readonly string[];
    n: number;
  }>({ was: HOSTS[0]!.values, now: HOSTS[0]!.values, n: 0 });

  const [testCmd, setTestCmd] = useState("");
  const [tested, setTested] = useState(false);
  const [cmd, setCmd] = useState("");
  const [caret, setCaret] = useState<"test" | "deploy" | null>(null);
  const [header, setHeader] = useState<number | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [done, setDone] = useState(false);

  const cancelRef = useRef<{ aborted: boolean }>({ aborted: false });
  const reelRef = useRef<HTMLOListElement>(null);
  // The values the code shows, across restarts.
  const valuesRef = useRef<readonly string[]>(HOSTS[0]!.values);

  useEffect(() => {
    const signal = { aborted: false };
    cancelRef.current.aborted = true;
    cancelRef.current = signal;
    const aborted = () => signal.aborted;

    const swapTo = async (i: number) => {
      const next = HOSTS[i]!.values;
      setHost(i);
      // The terminal waits for the new code.
      setTestCmd("");
      setTested(false);
      setCmd("");
      setHeader(null);
      setRows([]);
      setDone(false);
      const was = valuesRef.current;
      valuesRef.current = next;
      setRoll((r) => ({ was, now: next, n: r.n + 1 }));
      await sleep(ROLL_MS);
    };

    const deploy = async (i: number) => {
      const { resources } = HOSTS[i]!;
      setHeader(null);
      setRows([]);
      setDone(false);
      setCmd("");
      setTestCmd("");
      setTested(false);
      setCaret("test");
      const test = "pnpm test";
      for (let n = 1; n <= test.length; n++) {
        if (aborted()) return;
        setTestCmd(test.slice(0, n));
        await sleep(16);
      }
      await sleep(260);
      if (aborted()) return;
      setTested(true);
      await sleep(180);
      setCaret("deploy");
      const text = "alchemy deploy";
      for (let n = 1; n <= text.length; n++) {
        if (aborted()) return;
        setCmd(text.slice(0, n));
        await sleep(16);
      }
      await sleep(80);
      setCaret(null);
      setHeader(resources.length);
      for (const r of resources) {
        if (aborted()) return;
        await sleep(50);
        setRows((rs) => [...rs, { ...r, status: "ready" }]);
      }
      await sleep(120);
      for (const r of resources) {
        if (aborted()) return;
        setRows((rs) => rs.map((x) => (x.id === r.id ? { ...x, status: "creating" } : x)));
        await sleep(r.bindings ? 380 : 220);
        setRows((rs) => rs.map((x) => (x.id === r.id ? { ...x, status: "created" } : x)));
      }
      setDone(true);
    };

    const run = async () => {
      let i = start.at;
      if (start.key !== 0) await swapTo(i);
      while (!aborted()) {
        await deploy(i);
        if (aborted()) return;
        // Reduced motion: show the finished deploy and stop cycling hosts.
        if (prefersReducedMotion()) return;
        await sleep(1300);
        if (aborted()) return;
        i = (i + 1) % HOSTS.length;
        await swapTo(i);
      }
    };
    void run();
    return () => {
      signal.aborted = true;
    };
  }, [start]);

  // On phones the reel is one scrolling line: keep the current host in view.
  // Scrolls the reel only, never the page.
  useEffect(() => {
    const reel = reelRef.current;
    const item = reel?.children[host] as HTMLElement | undefined;
    if (!reel || !item || reel.scrollWidth <= reel.clientWidth) return;
    reel.scrollTo({
      left: item.offsetLeft - (reel.clientWidth - item.offsetWidth) / 2,
      behavior: "smooth",
    });
  }, [host]);

  const spinner = useSpinner(rows.some((r) => r.status === "creating"));
  const h = HOSTS[host]!;

  const code = <RollTemplate segments={SEGMENTS} was={roll.was} now={roll.now} n={roll.n} />;
  const compact = (
    <RollTemplate
      segments={SEGMENTS_COMPACT}
      was={compactValues(roll.was)}
      now={compactValues(roll.now)}
      n={roll.n}
    />
  );

  return (
    <>
      <ol ref={reelRef} className="v2-hero__reel hh-reel" aria-label="Platforms">
        {HOSTS.map((x, i) => (
          <li key={x.label}>
            <button
              type="button"
              className={`hh-reel__item ${i === host ? "is-active" : ""}`}
              aria-pressed={i === host}
              onClick={() => setStart((s) => ({ at: i, key: s.key + 1 }))}
            >
              {x.label}
            </button>
          </li>
        ))}
      </ol>
      <div className="v2-hero__code" aria-hidden>
        <div className="alc-code-block alc-code-block--compact">
          <div className="alc-code-block__header">
            <span className="alc-code-block__filename">src/Bank.ts</span>
          </div>
          <pre className="alc-code-block__pre hh-pre--full">{code}</pre>
          <pre className="alc-code-block__pre hh-pre--compact">{compact}</pre>
        </div>
      </div>
      <div className="v2-hero__term" aria-hidden>
        <TermChrome title="~/bank" badge="DEPLOY" badgeColor={GREEN} maxLines={9}>
          <Line>
            <span style={{ color: GREEN }}>$ </span>
            {testCmd}
            {caret === "test" && !tested && (
              <span style={{ color: "var(--alc-fg-invert)" }}>▍</span>
            )}
          </Line>
          {tested && (
            <Line>
              <span style={{ color: GREEN }}>✓ </span>
              14 stories
              <span style={{ color: GREEN }}>{"  ✓ "}</span>6 rules proved and checked
            </Line>
          )}
          {tested && (
            <Line>
              <span style={{ color: GREEN }}>$ </span>
              {cmd}
              {caret === "deploy" && <span style={{ color: "var(--alc-fg-invert)" }}>▍</span>}
            </Line>
          )}
          {header !== null && (
            <>
              <Line>
                <span
                  style={{
                    textDecoration: "underline",
                    color: GREEN,
                    fontWeight: 600,
                  }}
                >
                  Apply
                </span>
                <span>: </span>
                <span style={{ color: CREATE }}>{header} to create</span>
              </Line>
            </>
          )}
          {rows.map((r) => (
            <div key={r.id}>
              <Line>
                <span
                  style={{
                    color: CREATE,
                    width: "1.2em",
                    display: "inline-block",
                  }}
                >
                  {r.status === "ready" ? "+" : r.status === "creating" ? spinner : "✓"}
                </span>
                <span style={{ color: "var(--alc-fg-invert)", fontWeight: 600 }}>{r.id}</span>
                <span style={{ color: "var(--alc-code-comment)" }}>{` (${r.type})`}</span>
                {r.bindings && (
                  <span style={{ color: "var(--alc-code-type)" }}>
                    {` (${r.bindings.length} binding)`}
                  </span>
                )}
              </Line>
              {r.bindings?.map((b) => (
                <Line key={b}>
                  <span style={{ width: "2.4em", display: "inline-block" }}>
                    {"  "}
                    <span style={{ color: CREATE }}>+</span>
                  </span>
                  <span style={{ color: "var(--alc-code-type)" }}>{b}</span>
                </Line>
              ))}
            </div>
          ))}
          {done && (
            <Line>
              <span style={{ color: GREEN }}>✓ </span>
              deployed
            </Line>
          )}
          {/* The URL gets its own line so the fixed-width terminal fits it. */}
          {done && h.url && (
            <Line>
              <span style={{ color: GREEN }}>
                {"  "}
                {h.url}
              </span>
            </Line>
          )}
        </TermChrome>
      </div>
    </>
  );
}
