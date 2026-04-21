import { useEffect, useRef, useState, type ReactNode } from "react";
import { AWS_COLOR, tint } from "../marketing/diagrams/_colors";

const tok = (color: string) =>
  ({ children }: { children: ReactNode }) => <span style={{ color }}>{children}</span>;
const K = tok("var(--alc-code-keyword)");
const S = tok("var(--alc-code-string)");
const F = tok("var(--alc-code-fn)");
const T = tok("var(--alc-code-type)");
const V = tok("var(--alc-code-var)");
const C = ({ children }: { children: ReactNode }) => (
  <span style={{ color: "var(--alc-code-comment)", fontStyle: "italic" }}>{children}</span>
);

interface BindRow {
  id: string;
  call: ReactNode;
  resource: { label: string; sub: string; kind: "s3" | "ddb" | "ddb-stream" | "sqs" };
  arrow: { kind: "iam" | "stream"; label: string };
  policy: { action: string; resource: string };
}

const ROWS: BindRow[] = [
  {
    id: "get",
    call: (
      <>
        <K>const</K> get = <K>yield</K>* <V>S3</V>.<V>GetObject</V>.<F>bind</F>(<T>Photos</T>);
      </>
    ),
    resource: { label: "Photos", sub: "S3.Bucket", kind: "s3" },
    arrow: { kind: "iam", label: "Allow s3:GetObject" },
    policy: { action: "s3:GetObject", resource: "arn:aws:s3:::photos/*" },
  },
  {
    id: "put",
    call: (
      <>
        <K>const</K> put = <K>yield</K>* <V>DynamoDB</V>.<V>PutItem</V>.<F>bind</F>(<T>Jobs</T>);
      </>
    ),
    resource: { label: "Jobs", sub: "DynamoDB.Table", kind: "ddb" },
    arrow: { kind: "iam", label: "Allow dynamodb:PutItem" },
    policy: { action: "dynamodb:PutItem", resource: "arn:aws:dynamodb:*:*:table/Jobs" },
  },
  {
    id: "stream",
    call: (
      <>
        <K>yield</K>* <V>DynamoDB</V>.<F>stream</F>(<T>Jobs</T>).<F>process</F>(handler);
      </>
    ),
    resource: { label: "Jobs.stream", sub: "EventSourceMapping", kind: "ddb-stream" },
    arrow: { kind: "stream", label: "EventSource" },
    policy: { action: "dynamodb:GetRecords", resource: "stream/Jobs" },
  },
];

function ResourceIcon({ kind }: { kind: BindRow["resource"]["kind"] }) {
  const c = AWS_COLOR;
  const f = tint(c, 0.18);
  if (kind === "s3") {
    return (
      <svg width="22" height="22" viewBox="0 0 32 32" fill="none" aria-hidden>
        <path d="M6 8 L26 8 L24 25 C24 26.5 8 26.5 8 25 Z" fill={f} stroke={c} strokeWidth="1.4" strokeLinejoin="round" />
        <path d="M9 13 H23 M9 17 H23 M9 21 H19" stroke={c} strokeWidth="1.2" strokeLinecap="round" />
      </svg>
    );
  }
  if (kind === "ddb" || kind === "ddb-stream") {
    return (
      <svg width="22" height="22" viewBox="0 0 32 32" fill="none" aria-hidden>
        <ellipse cx="16" cy="8"  rx="10" ry="3" fill={f} stroke={c} strokeWidth="1.4" />
        <ellipse cx="16" cy="16" rx="10" ry="3" fill={f} stroke={c} strokeWidth="1.4" />
        <ellipse cx="16" cy="24" rx="10" ry="3" fill={f} stroke={c} strokeWidth="1.4" />
        {kind === "ddb-stream" && (
          <path d="M27 12 L30 16 L27 20" stroke={c} strokeWidth="1.4" fill="none" strokeLinecap="round" />
        )}
      </svg>
    );
  }
  return (
    <svg width="22" height="22" viewBox="0 0 32 32" fill="none" aria-hidden>
      <path d="M6 22 L16 6 L26 22 Z" fill={f} stroke={c} strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M12 22 L20 22 L18 26 L14 26 Z" fill={c} stroke={c} strokeWidth="1" />
    </svg>
  );
}

export default function BindingsToIAM() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(-1);

  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    const cycle = (i: number) => {
      if (cancelled) return;
      setActive(i);
      if (reduced) { setActive(ROWS.length - 1); return; }
      const next = (i + 1) % (ROWS.length + 1); // +1 = "all visible" pause frame
      const dwell = i === ROWS.length - 1 ? 2200 : 1300;
      timer = setTimeout(() => cycle(next === ROWS.length ? -1 : next), dwell);
    };

    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            cycle(0);
            obs.disconnect();
          }
        }
      },
      { threshold: 0.2 },
    );
    if (wrapRef.current) obs.observe(wrapRef.current);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      obs.disconnect();
    };
  }, []);

  return (
    <div ref={wrapRef} className="bindings-iam">
      {/* LEFT — Lambda code */}
      <div className="alc-code-block bindings-iam__code">
        <div className="alc-code-block__header">
          <span className="alc-code-block__dot" style={{ background: "var(--alc-danger)" }} />
          <span className="alc-code-block__dot" style={{ background: "var(--alc-warn)" }} />
          <span className="alc-code-block__dot" style={{ background: "var(--alc-accent-bright)" }} />
          <span className="alc-code-block__filename">src/JobApi.ts</span>
        </div>
        <pre className="alc-code-block__pre">
          <K>export default</K> <K>class</K> <T>JobApi</T> <K>extends</K>{" "}
          <V>AWS</V>.<V>Lambda</V>.<F>Function</F>{"<"}<T>JobApi</T>{">()("}
          {"\n  "}
          <S>"JobApi"</S>,
          {"\n  "}
          <V>Effect</V>.<F>gen</F>(<K>function</K>* () {"{"}
          {"\n    "}
          {ROWS.map((r, i) => (
            <span key={r.id}>
              <span
                data-row={r.id}
                className="bindings-iam__bind"
                style={{
                  padding: "1px 5px",
                  margin: "0 -5px",
                  borderRadius: 4,
                  background: active === i ? tint(AWS_COLOR, 0.22) : "transparent",
                  boxShadow: active === i ? `0 0 0 1px ${tint(AWS_COLOR, 0.55)}` : "none",
                  transition: "background 280ms ease, box-shadow 280ms ease",
                }}
              >
                {r.call}
              </span>
              {"\n    "}
            </span>
          ))}
          <C>{"// handler uses get / put / stream …"}</C>
          {"\n  "}
          {"}),"}
          {"\n"}
          {") {}"}
        </pre>
      </div>

      {/* MIDDLE — Animated arrows + labels */}
      <div className="bindings-iam__arrows" aria-hidden>
        <svg viewBox="0 0 200 280" preserveAspectRatio="none">
          <defs>
            <marker id="bia-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
              <path d="M0 0 L8 4 L0 8 Z" fill={AWS_COLOR} />
            </marker>
            <marker id="bia-arrow-stream" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
              <path d="M0 0 L8 4 L0 8 Z" fill="var(--alc-accent-bright)" />
            </marker>
          </defs>
          {ROWS.map((r, i) => {
            const y = 50 + i * 90;
            const isActive = active === i;
            const stroke = r.arrow.kind === "stream" ? "var(--alc-accent-bright)" : AWS_COLOR;
            const marker = r.arrow.kind === "stream" ? "url(#bia-arrow-stream)" : "url(#bia-arrow)";
            return (
              <g key={r.id} opacity={isActive ? 1 : 0.4} style={{ transition: "opacity 320ms ease" }}>
                <path
                  d={`M 0 ${y} L 190 ${y}`}
                  stroke={stroke}
                  strokeWidth={isActive ? 1.8 : 1.2}
                  fill="none"
                  markerEnd={marker}
                  strokeDasharray={r.arrow.kind === "stream" ? "5 4" : "0"}
                  style={{ transition: "stroke-width 280ms ease" }}
                />
                <text
                  x="100"
                  y={y - 8}
                  textAnchor="middle"
                  fontFamily="var(--alc-font-mono)"
                  fontSize="10"
                  fill={isActive ? stroke : "var(--alc-fg-3)"}
                  style={{ transition: "fill 280ms ease" }}
                >
                  {r.arrow.label}
                </text>
              </g>
            );
          })}
        </svg>
      </div>

      {/* RIGHT — Resources */}
      <div className="bindings-iam__resources">
        {ROWS.map((r, i) => {
          const isActive = active === i;
          return (
            <div
              key={r.id}
              className="bindings-iam__resource"
              style={{
                borderColor: isActive ? AWS_COLOR : "var(--alc-hairline)",
                boxShadow: isActive ? `0 0 0 2px ${tint(AWS_COLOR, 0.18)}` : "none",
                transition: "border-color 280ms ease, box-shadow 280ms ease",
              }}
            >
              <ResourceIcon kind={r.resource.kind} />
              <div>
                <div className="bindings-iam__resource-label">{r.resource.label}</div>
                <div className="bindings-iam__resource-sub">{r.resource.sub}</div>
              </div>
            </div>
          );
        })}
      </div>

      {/* BELOW — IAM policy that grows as binds activate */}
      <div className="bindings-iam__policy">
        <div className="alc-code-block__header">
          <span className="alc-code-block__dot" style={{ background: "var(--alc-danger)" }} />
          <span className="alc-code-block__dot" style={{ background: "var(--alc-warn)" }} />
          <span className="alc-code-block__dot" style={{ background: "var(--alc-accent-bright)" }} />
          <span className="alc-code-block__filename">JobApiRole · IAM policy</span>
          <span style={{ flex: 1 }} />
          <span
            style={{
              fontFamily: "var(--alc-font-mono)",
              fontSize: 10,
              letterSpacing: "0.14em",
              fontWeight: 700,
              padding: "2px 8px",
              borderRadius: 4,
              color: AWS_COLOR,
              border: `1px solid ${AWS_COLOR}`,
            }}
          >
            GENERATED
          </span>
        </div>
        <pre className="alc-code-block__pre">
          {"{"}
          {"\n  "}
          <S>"Version"</S>: <S>"2012-10-17"</S>,
          {"\n  "}
          <S>"Statement"</S>: [
          {ROWS.map((r, i) => {
            const visible = active >= i;
            return (
              <span
                key={r.id}
                style={{
                  display: "block",
                  paddingLeft: 16,
                  opacity: visible ? 1 : 0.08,
                  filter: visible ? "blur(0)" : "blur(2px)",
                  transform: visible ? "translateY(0)" : "translateY(-3px)",
                  transition: "opacity 360ms ease, filter 360ms ease, transform 360ms ease",
                }}
              >
                {"{ "}
                <S>"Effect"</S>: <S>"Allow"</S>,{" "}
                <S>"Action"</S>: <span style={{ color: AWS_COLOR }}>{`"${r.policy.action}"`}</span>,{" "}
                <S>"Resource"</S>: <S>{`"${r.policy.resource}"`}</S>{" "}
                {"}"}{i < ROWS.length - 1 ? "," : ""}
              </span>
            );
          })}
          {"\n  "}]
          {"\n"}
          {"}"}
        </pre>
      </div>
    </div>
  );
}
