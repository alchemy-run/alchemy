const { useState: useState3 } = React;

function CloudHero() {
  // Official brand SVGs served from cdn.simpleicons.org (slug/hex format).
  // Same CDN pattern as the React UMD scripts at the top of the page.
  const providers = [
    {
      name: "Cloudflare",
      color: "#F38020",
      logos: [{ slug: "cloudflare", hex: "F38020" }],
      desc: "Workers · R2 · KV · D1 · Durable Objects · Queues · Workflows · Containers",
    },
    {
      name: "AWS",
      color: "#FF9900",
      // Official AWS wordmark (smile + "aws"). simple-icons removed AWS in v15
      // for trademark review, so we use devicon's hosted version.
      logos: [{
        slug: "aws",
        src: "https://cdn.jsdelivr.net/gh/devicons/devicon@latest/icons/amazonwebservices/amazonwebservices-original-wordmark.svg",
        w: 56, h: 32,
      }],
      desc: "Lambda · S3 · DynamoDB · SQS · Kinesis · IAM · EC2",
    },
    {
      name: "+ more",
      color: "var(--alc-walnut-500)",
      logos: [
        { slug: "github", hex: "2A2620" },
        { slug: "stripe", hex: "635BFF" },
        { slug: "namecheap", hex: "DE3910" },
      ],
      desc: "GitHub · Stripe · DNS · and a growing community ecosystem",
    },
  ];
  return (
    <Section padding="72px 32px 48px">
      <div style={{ textAlign: "center", marginBottom: 24 }}><AlphaBadge /></div>
      <div style={{ textAlign: "center", maxWidth: 880, margin: "0 auto 48px" }}>
        <Eyebrow>cloudflare · aws · and any cloud you bring</Eyebrow>
        <h1 style={{
          fontFamily: "var(--alc-font-serif)", fontWeight: 500,
          fontSize: 76, lineHeight: 1.02, letterSpacing: "-0.02em",
          margin: "18px 0 20px", color: "var(--alc-fg-1)",
        }}>
          One <span style={{ color: "var(--alc-accent-deep)", fontStyle: "italic" }}>Stack</span>.<br/>Your whole cloud.
        </h1>
        <p style={{ fontSize: 19, lineHeight: 1.55, color: "var(--alc-fg-2)", maxWidth: 640, margin: "0 auto 32px" }}>
          Declare resources. Bind them to Workers and Lambdas. Deploy with one command. Everything is just TypeScript and Effect — no YAML, no Go binary, no runtime wiring.
        </p>
        <div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
          <Button variant="primary" icon="arrow">Get started</Button>
          <Button variant="secondary">Tutorial</Button>
          <Button variant="ghost" icon="github">GitHub</Button>
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16, maxWidth: 1100, margin: "0 auto" }}>
        {providers.map(p => (
          <div key={p.name} style={{
            background: "var(--alc-bg-elev-1)", border: "1px solid var(--alc-hairline)",
            borderRadius: 12, padding: 22, display: "flex", flexDirection: "column", gap: 10,
          }}>
            <div style={{
              height: 36, display: "flex", alignItems: "center", gap: 10,
            }}>
              {p.logos.map(l => {
                const baseSize = p.logos.length > 1 ? 26 : 32;
                return (
                  <img
                    key={l.slug}
                    src={l.src || `https://cdn.simpleicons.org/${l.slug}/${l.hex}`}
                    alt={`${l.slug} logo`}
                    width={l.w || baseSize}
                    height={l.h || baseSize}
                    style={{ display: "block" }}
                  />
                );
              })}
            </div>
            <div style={{ fontFamily: "var(--alc-font-sans)", fontSize: 17, fontWeight: 600, color: "var(--alc-fg-1)" }}>{p.name}</div>
            <div style={{ fontSize: 13, color: "var(--alc-fg-3)", lineHeight: 1.55 }}>{p.desc}</div>
          </div>
        ))}
      </div>
    </Section>
  );
}

// A Stack entrypoint — the real shape, paired with what `deploy` actually prints
function CloudStackExample() {
  return (
    <Section padding="40px 32px 80px">
      <div style={{ textAlign: "center", marginBottom: 36 }}>
        <Eyebrow>the shape of a stack</Eyebrow>
        <h2 className="alc-h2" style={{ margin: "12px 0 12px" }}>One file in. One deploy out.</h2>
        <p style={{ fontSize: 16, lineHeight: 1.65, color: "var(--alc-fg-2)", maxWidth: 620, margin: "12px auto 0" }}>
          A <code style={{ fontFamily: "var(--alc-font-mono)", fontSize: 14, color: "var(--alc-accent-deep)" }}>Stack</code> is an Effect that declares resources and returns typed outputs. Run <code style={{ fontFamily: "var(--alc-font-mono)", fontSize: 14, color: "var(--alc-accent-deep)" }}>alchemy deploy</code> and the same program ships to your cloud.
        </p>
      </div>

      <div className="stack-deploy-diagram">
        <div className="stack-deploy-diagram__col">
          <CodeBlock filename="alchemy.run.ts">
{T.k("export default")} {T.v("Alchemy")}.{T.f("Stack")}({"\n"}
{"  "}{T.s('"MyApp"')},{"\n"}
{"  "}{"{ providers: "}{T.v("Cloudflare")}.{T.f("providers")}() {"}"},{"\n"}
{"  "}{T.v("Effect")}.{T.f("gen")}({T.k("function")}* () {"{"}{"\n"}
{"    "}{T.k("const")} bucket = {T.k("yield")}* {T.v("Bucket")};{"\n"}
{"    "}{T.k("const")} queue  = {T.k("yield")}* {T.v("Queue")};{"\n"}
{"    "}{T.k("const")} api    = {T.k("yield")}* {T.v("Api")};{"\n"}
{"\n"}
{"    "}{T.c("// typed url returned to the caller")}{"\n"}
{"    "}{T.k("return")} {"{ url: api.url };"}{"\n"}
{"  "}{"}),"}{"\n"}
{");"}
          </CodeBlock>
          <div className="stack-deploy-diagram__caption">
            <SketchLabel>your Stack</SketchLabel>
            <span>one program, every resource</span>
          </div>
        </div>

        <div className="stack-deploy-diagram__bridge" aria-hidden="true">
          <span className="stack-deploy-diagram__label">alchemy deploy</span>
          <svg className="stack-deploy-diagram__arrow" viewBox="0 0 220 60" preserveAspectRatio="none">
            <defs>
              <marker id="sd-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="8" markerHeight="8" orient="auto">
                <path d="M0,0 L10,5 L0,10 z" fill="var(--alc-accent)" />
              </marker>
            </defs>
            <path d="M 4 30 C 70 14, 150 46, 214 30"
                  fill="none" stroke="var(--alc-accent)" strokeWidth="3"
                  strokeLinecap="round" markerEnd="url(#sd-arrow)" />
          </svg>
          <span className="stack-deploy-diagram__sublabel">plan · diff · apply</span>
        </div>

        <div className="stack-deploy-diagram__col">
          <DeployTerminal />
          <div className="stack-deploy-diagram__caption">
            <SketchLabel>your Cloud</SketchLabel>
            <span>live · typed · reproducible</span>
          </div>
        </div>
      </div>
    </Section>
  );
}

// Resources are their own files — show two real ones side-by-side with the Worker
function CloudResourcesAndWorker() {
  return (
    <Section padding="80px 32px" style={{ background: "var(--alc-bg-nav)" }}>
      <div style={{ textAlign: "center", marginBottom: 40 }}>
        <Eyebrow>resources · bindings · workers</Eyebrow>
        <h2 className="alc-h2" style={{ margin: "12px 0 12px" }}>Declare once. Bind where you use it.</h2>
        <p style={{ fontSize: 16, lineHeight: 1.65, color: "var(--alc-fg-2)", maxWidth: 620, margin: "12px auto 0" }}>
          A resource is a one-liner. <code style={{ fontFamily: "var(--alc-font-mono)", fontSize: 14, color: "var(--alc-accent-deep)" }}>.bind()</code> inside a Worker gives you a typed runtime client — and wires the binding at deploy time.
        </p>
      </div>

      <div className="binding-diagram">
        <div className="binding-diagram__left">
          <CodeBlock filename="src/Api.ts">
{T.k("export default")} {T.k("class")} {T.t("Api")} {T.k("extends")} {T.v("Cloudflare")}.{T.f("Worker")}{"<"}{T.t("Api")}{">()"}({"\n"}
{"  "}{T.s('"Api"')},{"\n"}
{"  "}{"{ main: "}{T.v("import")}.meta.path, assets: {T.s('"./assets"')} {"},"}{"\n"}
{"  "}{T.v("Effect")}.{T.f("gen")}({T.k("function")}* () {"{"}{"\n"}
{"    "}{T.c("// typed runtime clients · bindings wired at deploy")}{"\n"}
{"    "}{T.k("const")} bucket = {T.k("yield")}* {T.v("R2Bucket")}.{T.f("bind")}({T.v("Bucket")});{"\n"}
{"    "}{T.k("const")} kv     = {T.k("yield")}* {T.v("KVNamespace")}.{T.f("bind")}({T.v("KV")});{"\n\n"}
{"    "}{T.k("return")} {"{ fetch: /* your handler uses bucket & kv */ };"}{"\n"}
{"  "}{"}),"}{"\n"}
{") {"}{"}"}
          </CodeBlock>
        </div>

        <div className="binding-diagram__arrows" aria-hidden="true">
          <svg viewBox="0 0 120 320" preserveAspectRatio="none">
            <defs>
              <marker id="bd-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
                <path d="M0,0 L10,5 L0,10 z" fill="var(--alc-accent)" />
              </marker>
            </defs>
            {/* bucket binding — exits Api at the .bind(Bucket) line, enters Bucket.ts box top-right */}
            <path d="M 0 165 C 60 165, 60 70, 120 70"
                  fill="none" stroke="var(--alc-accent)" strokeWidth="2"
                  strokeLinecap="round" markerEnd="url(#bd-arrow)" />
            {/* kv binding — exits Api at the .bind(KV) line, enters KV.ts box bottom-right */}
            <path d="M 0 200 C 60 200, 60 250, 120 250"
                  fill="none" stroke="var(--alc-accent)" strokeWidth="2"
                  strokeLinecap="round" markerEnd="url(#bd-arrow)" />
          </svg>
          <span className="binding-diagram__label binding-diagram__label--top">.bind(Bucket)</span>
          <span className="binding-diagram__label binding-diagram__label--bottom">.bind(KV)</span>
        </div>

        <div className="binding-diagram__right">
          <CodeBlock filename="src/Bucket.ts" compact>
{T.k("export const")} {T.v("Bucket")} = {T.v("Cloudflare")}.{T.f("R2Bucket")}({T.s('"Bucket"')});
          </CodeBlock>
          <CodeBlock filename="src/KV.ts" compact>
{T.k("export const")} {T.v("KV")} = {T.v("Cloudflare")}.{T.f("KVNamespace")}({T.s('"KV"')});
          </CodeBlock>
        </div>
      </div>

      <div style={{ maxWidth: 920, margin: "32px auto 0", display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16 }}>
        {[
          { t: "Resources are Effects", d: "Each resource returns typed Outputs that flow into other resources automatically." },
          { t: "Bindings are typed", d: ".bind(resource) returns an Effect-flavored client. The deploy-time policy attaches itself." },
          { t: "Workers are classes", d: "Extend Cloudflare.Worker<T>. The body is Effect.gen — your runtime code, typed." },
        ].map(c => (
          <div key={c.t} style={{
            background: "var(--alc-bg-elev-1)", border: "1px solid var(--alc-hairline)",
            borderRadius: 10, padding: 18,
          }}>
            <div style={{ fontFamily: "var(--alc-font-sans)", fontSize: 15, fontWeight: 600, color: "var(--alc-fg-1)", marginBottom: 6 }}>{c.t}</div>
            <div style={{ fontSize: 13, lineHeight: 1.55, color: "var(--alc-fg-3)" }}>{c.d}</div>
          </div>
        ))}
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// CloudFeatureTabs — full export defaults from real examples + block diagrams
// ---------------------------------------------------------------------------

// Lightweight TS highlighter — single-pass regex over the source text.
function highlightTS(src) {
  const re = /(\/\/[^\n]*)|(\/\*[\s\S]*?\*\/)|("(?:[^"\\]|\\.)*")|('(?:[^'\\]|\\.)*')|(`(?:[^`\\]|\\.)*`)|\b(import|export|default|class|extends|const|let|var|function|return|yield|if|else|for|of|in|as|new|typeof|async|await|from|interface|type|null|true|false|this|void|throw)\b|\b(\d+)\b|([A-Z][a-zA-Z0-9_]*)|([a-z_$][a-zA-Z0-9_$]*)/g;
  const out = [];
  let last = 0, m, k = 0;
  const push = (node) => out.push(node);
  while ((m = re.exec(src)) !== null) {
    if (m.index > last) push(src.slice(last, m.index));
    if (m[1] || m[2]) {
      push(<span key={k++} style={{ color: "var(--alc-code-comment)", fontStyle: "italic" }}>{m[0]}</span>);
    } else if (m[3] || m[4] || m[5]) {
      push(<span key={k++} style={{ color: "var(--alc-code-string)" }}>{m[0]}</span>);
    } else if (m[6]) {
      push(<span key={k++} style={{ color: "var(--alc-code-keyword)" }}>{m[0]}</span>);
    } else if (m[7]) {
      push(<span key={k++} style={{ color: "var(--alc-code-literal)" }}>{m[0]}</span>);
    } else if (m[8]) {
      push(<span key={k++} style={{ color: "var(--alc-code-type)" }}>{m[0]}</span>);
    } else if (m[9]) {
      push(<span key={k++} style={{ color: "var(--alc-code-var)" }}>{m[0]}</span>);
    }
    last = re.lastIndex;
  }
  if (last < src.length) push(src.slice(last));
  return out;
}

// ---- Inline SVG icons for the diagram nodes ----
// Each icon is a 32x32 viewBox; we tint via stroke/fill on currentColor / accent.

function IconClient({ size = 26 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden>
      <circle cx="16" cy="16" r="11" stroke="var(--alc-fg-3)" strokeWidth="1.4" />
      <ellipse cx="16" cy="16" rx="5" ry="11" stroke="var(--alc-fg-3)" strokeWidth="1.2" />
      <line x1="5" y1="16" x2="27" y2="16" stroke="var(--alc-fg-3)" strokeWidth="1.2" />
    </svg>
  );
}

function IconWorker({ size = 26 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden>
      <rect x="3" y="3" width="26" height="26" rx="6"
            fill="var(--alc-accent-12)" stroke="var(--alc-accent)" strokeWidth="1.4" />
      <path d="M19 7 L10 18 H15 L13 25 L22 13 H17 Z"
            fill="var(--alc-accent)" stroke="none" />
    </svg>
  );
}

function IconR2({ size = 26 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden>
      <ellipse cx="16" cy="9" rx="10" ry="3"
               fill="var(--alc-accent-12)" stroke="var(--alc-accent)" strokeWidth="1.5" />
      <path d="M6 9 V23 C6 24.7 10.5 26 16 26 C21.5 26 26 24.7 26 23 V9"
            fill="var(--alc-accent-12)" stroke="var(--alc-accent)" strokeWidth="1.5" />
      <path d="M6 16 C6 17.7 10.5 19 16 19 C21.5 19 26 17.7 26 16"
            stroke="var(--alc-accent)" strokeWidth="1" strokeOpacity="0.55" fill="none" />
    </svg>
  );
}

function IconKV({ size = 26 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden>
      <circle cx="11" cy="16" r="6"
              fill="var(--alc-accent-12)" stroke="var(--alc-accent)" strokeWidth="1.5" />
      <circle cx="11" cy="16" r="2.2" fill="var(--alc-accent)" />
      <path d="M17 16 L27 16 M23 16 L23 21 M27 16 L27 12"
            stroke="var(--alc-accent)" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function IconDO({ size = 26 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden>
      <path d="M16 3 L28 10 L28 22 L16 29 L4 22 L4 10 Z"
            fill="var(--alc-accent-12)" stroke="var(--alc-accent)" strokeWidth="1.5" />
      <circle cx="16" cy="16" r="3.5" fill="var(--alc-accent)" />
    </svg>
  );
}

// ---- Node + connector primitives ----

function DiagNode({ icon, label, sub, accent, dim }) {
  return (
    <div style={{
      background: dim ? "var(--alc-bg)" : "var(--alc-bg-elev-1)",
      border: `1px solid ${accent ? "var(--alc-accent-40)" : "var(--alc-hairline-2)"}`,
      borderRadius: 10,
      padding: "10px 12px 8px",
      minWidth: 92,
      display: "flex", flexDirection: "column", alignItems: "center", gap: 4,
      boxShadow: accent ? "0 0 0 2px var(--alc-accent-12)" : "none",
      textAlign: "center",
    }}>
      {icon}
      <div style={{
        fontFamily: "var(--alc-font-sans)", fontSize: 12, fontWeight: 600,
        color: "var(--alc-fg-1)", lineHeight: 1.2,
      }}>{label}</div>
      {sub && (
        <div style={{
          fontFamily: "var(--alc-font-mono)", fontSize: 10,
          color: "var(--alc-fg-3)", lineHeight: 1.25,
        }}>{sub}</div>
      )}
    </div>
  );
}

function DiagArrow({ label, height = 22 }) {
  return (
    <div style={{
      display: "flex", flexDirection: "column", alignItems: "center",
      gap: 2, padding: "2px 0",
    }}>
      {label && (
        <div style={{
          fontFamily: "var(--alc-font-mono)", fontSize: 10,
          color: "var(--alc-fg-3)",
        }}>{label}</div>
      )}
      <svg width="14" height={height} viewBox={`0 0 14 ${height}`}>
        <path d={`M7 0 L7 ${height - 6}`} stroke="var(--alc-accent)" strokeWidth="1.4" />
        <path d={`M3 ${height - 8} L7 ${height - 1} L11 ${height - 8}`}
          stroke="var(--alc-accent)" strokeWidth="1.4" fill="none"
          strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  );
}

// Bidirectional arrow (one up + one down, side-by-side) with optional labels.
function DiagBidir({ topLabel, bottomLabel, height = 30 }) {
  return (
    <div style={{
      display: "flex", flexDirection: "column", alignItems: "center",
      gap: 2, padding: "2px 0",
    }}>
      {topLabel && (
        <div style={{ fontFamily: "var(--alc-font-mono)", fontSize: 10, color: "var(--alc-fg-3)" }}>
          {topLabel}
        </div>
      )}
      <svg width="28" height={height} viewBox={`0 0 28 ${height}`}>
        {/* up arrow on the left */}
        <path d={`M9 ${height - 1} L9 5`} stroke="var(--alc-accent)" strokeWidth="1.4" />
        <path d={`M6 7 L9 1 L12 7`} stroke="var(--alc-accent)" strokeWidth="1.4" fill="none"
          strokeLinecap="round" strokeLinejoin="round" />
        {/* down arrow on the right */}
        <path d={`M19 1 L19 ${height - 5}`} stroke="var(--alc-accent)" strokeWidth="1.4" />
        <path d={`M16 ${height - 7} L19 ${height - 1} L22 ${height - 7}`}
          stroke="var(--alc-accent)" strokeWidth="1.4" fill="none"
          strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {bottomLabel && (
        <div style={{ fontFamily: "var(--alc-font-mono)", fontSize: 10, color: "var(--alc-fg-3)" }}>
          {bottomLabel}
        </div>
      )}
    </div>
  );
}

// Fan-out: parent on top, N children below, connected by a horizontal bus.
function DiagFanOut({ parent, children: kids, label }) {
  const N = kids.length;
  const startPct = 100 / (N * 2);
  return (
    <div style={{ width: "100%", display: "flex", flexDirection: "column", alignItems: "center" }}>
      {parent}
      {label && (
        <div style={{
          marginTop: 4,
          fontFamily: "var(--alc-font-mono)", fontSize: 10, color: "var(--alc-fg-3)",
        }}>{label}</div>
      )}
      {/* connector area: trunk -> bus -> drops + arrowheads */}
      <div style={{ position: "relative", height: 28, width: "100%", marginTop: 2 }}>
        {/* trunk (parent center → bus) */}
        <div style={{
          position: "absolute", left: "50%", top: 0, height: 9, width: 0,
          borderLeft: "1.4px solid var(--alc-accent)", transform: "translateX(-0.5px)",
        }} />
        {/* horizontal bus */}
        <div style={{
          position: "absolute", top: 8, left: `${startPct}%`, right: `${startPct}%`,
          borderTop: "1.4px solid var(--alc-accent)",
        }} />
        {/* drops + arrowheads into each child */}
        {kids.map((_, i) => {
          const x = `${startPct * (2 * i + 1)}%`;
          return (
            <React.Fragment key={i}>
              <div style={{
                position: "absolute", top: 9, left: x, height: 14, width: 0,
                borderLeft: "1.4px solid var(--alc-accent)", transform: "translateX(-0.5px)",
              }} />
              <svg width="8" height="6" style={{
                position: "absolute", top: 22, left: x, transform: "translateX(-4px)",
              }}>
                <path d="M0 0 L4 6 L8 0" stroke="var(--alc-accent)" strokeWidth="1.4"
                  fill="none" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </React.Fragment>
          );
        })}
      </div>
      <div style={{
        display: "grid", gridTemplateColumns: `repeat(${N}, 1fr)`, gap: 6, width: "100%",
      }}>
        {kids.map((c, i) => (
          <div key={i} style={{ display: "flex", justifyContent: "center" }}>{c}</div>
        ))}
      </div>
    </div>
  );
}

function DiagWrap({ children }) {
  return (
    <div style={{
      display: "flex", flexDirection: "column", alignItems: "center",
      padding: "8px 4px", gap: 0, width: "100%",
    }}>{children}</div>
  );
}

// ---- Diagrams per tab — each topology is intentionally different ----

// Linear: Client → Worker → Bucket
function DiagramR2() {
  return (
    <DiagWrap>
      <DiagNode icon={<IconClient />} label="Client" sub="HTTP" dim />
      <DiagArrow label="GET /key" />
      <DiagNode icon={<IconWorker />} label="Api" sub="Worker" accent />
      <DiagArrow label=".bind(Bucket)" />
      <DiagNode icon={<IconR2 />} label="Bucket" sub="R2" />
    </DiagWrap>
  );
}

// Bidirectional: Worker ↔ KV (read + write)
function DiagramKV() {
  return (
    <DiagWrap>
      <DiagNode icon={<IconWorker />} label="Api" sub="Worker" accent />
      <DiagBidir topLabel="kv.put(k, v)" bottomLabel="kv.get(k)" height={36} />
      <DiagNode icon={<IconKV />} label="KV" sub="key/value" />
    </DiagWrap>
  );
}

// Fan-out: one Worker routes to many Room instances by name
function DiagramRoom() {
  return (
    <DiagWrap>
      <DiagFanOut
        parent={<DiagNode icon={<IconWorker />} label="Api" sub="Worker" accent />}
        label="rooms.getByName(id)"
        children={[
          <DiagNode icon={<IconDO />} label="Room" sub="#alpha" />,
          <DiagNode icon={<IconDO />} label="Room" sub="#beta" />,
          <DiagNode icon={<IconDO />} label="Room" sub="#gamma" />,
        ]}
      />
    </DiagWrap>
  );
}

// ---- Source snippets per tab — tight binding-only views ----

const SRC_R2 = `import { Bucket } from "./Bucket.ts";

export default class Api extends Cloudflare.Worker<Api>()(
  "Api",
  Effect.gen(function* () {
    const bucket = yield* Cloudflare.R2Bucket.bind(Bucket);
    return { fetch: (req) => bucket.get(req.url) };
  }),
) {}
`;

const SRC_KV = `import { KV } from "./KV.ts";

export default class Api extends Cloudflare.Worker<Api>()(
  "Api",
  Effect.gen(function* () {
    const kv = yield* Cloudflare.KVNamespace.bind(KV);
    return { fetch: (req) => kv.get(req.url) };
  }),
) {}
`;

const SRC_DO = `import Room from "./Room.ts";

export default class Api extends Cloudflare.Worker<Api>()(
  "Api",
  Effect.gen(function* () {
    const rooms = yield* Room;
    return { fetch: (req) => rooms.getByName(req.url).fetch(req) };
  }),
) {}
`;

// Tabs for Cloudflare feature breadth — full export defaults, side-by-side diagrams.
function CloudFeatureTabs() {
  const [tab, setTab] = useState3("r2");
  const examples = [
    {
      k: "r2",
      label: "R2 Bucket",
      filename: "src/Api.ts",
      caption: "Bind an R2 bucket inside a Worker — typed client, deploy-time wiring.",
      src: SRC_R2,
      diagram: <DiagramR2 />,
    },
    {
      k: "kv",
      label: "KV",
      filename: "src/Api.ts",
      caption: "The same .bind() shape — get and put from the same typed client.",
      src: SRC_KV,
      diagram: <DiagramKV />,
    },
    {
      k: "do",
      label: "Durable Object",
      filename: "src/Api.ts",
      caption: "Yield the Room namespace, then route by name — one DO instance per id.",
      src: SRC_DO,
      diagram: <DiagramRoom />,
    },
  ];
  const active = examples.find(e => e.k === tab) || examples[0];

  return (
    <Section padding="80px 32px" maxWidth={1000}>
      <div style={{ textAlign: "center", marginBottom: 36 }}>
        <Eyebrow>bindings · the same shape, every primitive</Eyebrow>
        <h2 className="alc-h2" style={{ margin: "12px 0 12px" }}>Typed all the way down.</h2>
        <p style={{ fontSize: 16, lineHeight: 1.65, color: "var(--alc-fg-2)", maxWidth: 620, margin: "12px auto 0" }}>
          Declare a resource once. Bind it inside a Worker. The runtime client is typed,
          the deploy-time wiring is automatic.
        </p>
      </div>

      <div style={{ display: "flex", justifyContent: "center", gap: 4, marginBottom: 18, flexWrap: "wrap" }}>
        {examples.map(t => (
          <button key={t.k} onClick={() => setTab(t.k)} style={{
            border: "1px solid var(--alc-hairline-2)",
            background: tab === t.k ? "var(--alc-bg-code)" : "var(--alc-bg-elev-1)",
            color: tab === t.k ? "var(--alc-fg-invert)" : "var(--alc-fg-2)",
            fontFamily: "var(--alc-font-mono)", fontSize: 12.5,
            padding: "8px 16px", borderRadius: 8, cursor: "pointer",
          }}>{t.label}</button>
        ))}
      </div>

      <div style={{
        textAlign: "center", maxWidth: 680, margin: "0 auto 18px",
        fontFamily: "var(--alc-font-sans)", fontSize: 13.5,
        color: "var(--alc-fg-3)", lineHeight: 1.55,
      }}>
        {active.caption}
      </div>

      <div className="feature-tab-grid">
        <CodeBlock filename={active.filename} compact>
          {highlightTS(active.src)}
        </CodeBlock>
        <div className="feature-tab-diagram">
          <div style={{
            background: "var(--alc-bg-elev-1)",
            border: "1px solid var(--alc-hairline)",
            borderRadius: 10, padding: "14px 12px",
          }}>
            {active.diagram}
          </div>
        </div>
      </div>
    </Section>
  );
}

// Dedicated — integration tests against real infra
function CloudIntegrationTests() {
  return (
    <Section padding="96px 32px" style={{ background: "var(--alc-bg-nav)" }}>
      <div style={{ textAlign: "center", marginBottom: 48 }}>
        <Eyebrow>integration tests · against real infra</Eyebrow>
        <h2 className="alc-h2" style={{ margin: "12px 0 14px" }}>
          <span style={{ fontStyle: "italic", color: "var(--alc-accent-deep)" }}>Deploy</span>, test, destroy — in one file.
        </h2>
        <p style={{ fontSize: 16, lineHeight: 1.65, color: "var(--alc-fg-2)", maxWidth: 640, margin: "0 auto" }}>
          Because a stack is just an <code style={{ fontFamily: "var(--alc-font-mono)", fontSize: 14, color: "var(--alc-accent-deep)" }}>Effect</code>, you can yield it from a test. Spin up a fresh environment in <code style={{ fontFamily: "var(--alc-font-mono)", fontSize: 14, color: "var(--alc-accent-deep)" }}>beforeAll</code>, hit the live URL, tear it down in <code style={{ fontFamily: "var(--alc-font-mono)", fontSize: 14, color: "var(--alc-accent-deep)" }}>afterAll</code>.
        </p>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(260px, 360px) 1fr", gap: 32, maxWidth: 1100, margin: "0 auto", alignItems: "start" }}>
        <div style={{ position: "sticky", top: 100 }}>
          <div style={{
            fontFamily: "var(--alc-font-mono)", fontSize: 11, letterSpacing: "0.08em",
            textTransform: "uppercase", color: "var(--alc-fg-3)", marginBottom: 14,
          }}>what this replaces</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {[
              { k: "Mocks that lie", d: "LocalStack and mocks drift. alchemy deploys the real resource — R2 buckets, Workers, DOs — every run." },
              { k: "Long-lived test envs", d: "No shared “dev” account to reset. A per-suite stage spins up in seconds and disappears when the test ends." },
              { k: "A separate tooling tier", d: "No Terratest, no Pulumi CrossGuard. Your test runner — vitest, bun:test — runs the stack." },
            ].map(x => (
              <div key={x.k} style={{ borderLeft: "2px solid var(--alc-accent)", paddingLeft: 14 }}>
                <div style={{ fontFamily: "var(--alc-font-sans)", fontSize: 14.5, fontWeight: 600, color: "var(--alc-fg-1)", marginBottom: 3 }}>{x.k}</div>
                <div style={{ fontSize: 13, lineHeight: 1.6, color: "var(--alc-fg-3)" }}>{x.d}</div>
              </div>
            ))}
          </div>
        </div>

        <div>
          <CodeBlock filename="test/api.test.ts">
{T.c("// 1. deploy the real stack once, into an isolated stage")}{"\n"}
{T.k("const")} stack = {T.f("beforeAll")}({T.f("deploy")}({T.v("Stack")}, {"{"} stage: {T.s('`pr-${Date.now()}`')} {"}"}));{"\n"}
{T.f("afterAll")}.{T.f("skipIf")}(!{T.v("process")}.env.CI)({T.f("destroy")}({T.v("Stack")}));{"\n\n"}
{T.c("// 2. each test yields the live URL and hits it over HTTP")}{"\n"}
{T.f("test")}({T.s('"PUT + GET round-trips through R2"')}, {T.v("Effect")}.{T.f("gen")}({T.k("function")}* () {"{"}{"\n"}
{"  "}{T.k("const")} {"{ url }"} = {T.k("yield")}* stack;{"\n\n"}
{"  "}{T.k("yield")}* {T.v("HttpClient")}.{T.f("put")}({T.s('`${url}/object/hello.txt`')}, {"{"}{"\n"}
{"    "}body: {T.v("HttpBody")}.{T.f("text")}({T.s('"hi!"')}),{"\n"}
{"  "}{"});"}{"\n\n"}
{"  "}{T.k("const")} res = {T.k("yield")}* {T.v("HttpClient")}.{T.f("get")}({T.s('`${url}/object/hello.txt`')});{"\n"}
{"  "}{T.f("expect")}({T.k("yield")}* res.text).{T.f("toBe")}({T.s('"hi!"')});{"\n"}
{"}));"}{"\n\n"}
{T.c("// 3. assert durable state — no mocks, just the live DO")}{"\n"}
{T.f("test")}({T.s('"Room DO preserves state across requests"')}, {T.v("Effect")}.{T.f("gen")}({T.k("function")}* () {"{"}{"\n"}
{"  "}{T.k("const")} {"{ url }"} = {T.k("yield")}* stack;{"\n"}
{"  "}{T.k("yield")}* {T.v("HttpClient")}.{T.f("post")}({T.s('`${url}/room/general/join`')});{"\n"}
{"  "}{T.k("const")} res = {T.k("yield")}* {T.v("HttpClient")}.{T.f("get")}({T.s('`${url}/room/general`')});{"\n"}
{"  "}{T.f("expect")}(({T.k("yield")}* res.json).members).{T.f("toHaveLength")}({T.n("1")});{"\n"}
{"}));"}
          </CodeBlock>

          <div style={{ marginTop: 20 }}>
            <Terminal title="CI · pr-1729" content={`[d]$[/d] bun test

[g]✓[/g] [b]deploy[/b] [d](3 resources · 4.2s)[/d]
  [s2][d]→ https://api.pr-1729.workers.dev[/d]

[g]✓[/g] PUT + GET round-trips through R2 [d](312ms)[/d]
[g]✓[/g] Room DO preserves state across requests [d](184ms)[/d]

[g]✓[/g] [b]destroy[/b] [d](3 resources · 1.8s)[/d]

[g] PASS [/g]  2 tests · [b]10.6s[/b]`} />
          </div>
        </div>
      </div>

      <div style={{ maxWidth: 1100, margin: "40px auto 0", display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16 }}>
        {[
          { t: "Per-PR environments", d: "Stage named from the PR number. Every pull request gets its own URL, automatically cleaned up on merge." },
          { t: "Same binary, any stage", d: "alchemy dev, alchemy deploy, and alchemy test all execute the same Effect — just with different stage / provider layers." },
          { t: "Typed URLs, typed clients", d: "stack's output type is exactly what Stack returns. url, queue, bucket — autocompleted in your test body." },
        ].map(c => (
          <div key={c.t} style={{
            background: "var(--alc-bg-elev-1)", border: "1px solid var(--alc-hairline)",
            borderRadius: 10, padding: 18,
          }}>
            <div style={{ fontFamily: "var(--alc-font-sans)", fontSize: 15, fontWeight: 600, color: "var(--alc-fg-1)", marginBottom: 6 }}>{c.t}</div>
            <div style={{ fontSize: 13, lineHeight: 1.55, color: "var(--alc-fg-3)" }}>{c.d}</div>
          </div>
        ))}
      </div>
    </Section>
  );
}

// Catalog of what you can actually deploy — based on real package layout
function CloudProviderGrid() {
  const groups = [
    { cloud: "Cloudflare", color: "#f38020", resources: [
      "Worker","R2Bucket","KVNamespace","D1Database","DurableObjectNamespace",
      "Queue","Workflow","Container","DynamicWorkerLoader","WorkerAssets",
    ]},
    { cloud: "AWS", color: "#ff9900", resources: [
      "Lambda.Function","S3.Bucket","DynamoDB.Table","SQS.Queue","Kinesis.Stream",
      "IAM.Role","IAM.Policy","EC2.VPC","EventBridge.Rule","EventBridge.EventBus",
    ]},
    { cloud: "Bindings (runtime clients)", color: "var(--alc-accent-deep)", resources: [
      "R2Bucket.bind", "KVNamespace.bind", "Container.bind",
      "S3.GetObject.bind", "S3.PutObject.bind", "DynamoDB.PutItem.bind", "Kinesis.PutRecord.bind",
    ]},
    { cloud: "+ Community", color: "var(--alc-walnut-500)", resources: [
      "GitHub.Repo","GitHub.Workflow","Stripe.Product","DNS.Record","Docker.Image",
    ]},
  ];
  return (
    <Section padding="96px 32px">
      <div style={{ textAlign: "center", marginBottom: 48 }}>
        <Eyebrow>catalog</Eyebrow>
        <h2 className="alc-h2" style={{ margin: "12px 0 12px" }}>What you can deploy, today.</h2>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
        {groups.map(g => (
          <div key={g.cloud} style={{ background: "var(--alc-bg-elev-1)", border: "1px solid var(--alc-hairline)", borderRadius: 12, padding: 24 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
              <span style={{ width: 10, height: 10, borderRadius: 3, background: g.color }} />
              <span style={{ fontFamily: "var(--alc-font-sans)", fontSize: 17, fontWeight: 600, color: "var(--alc-fg-1)" }}>{g.cloud}</span>
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {g.resources.map(r => (
                <span key={r} style={{
                  fontFamily: "var(--alc-font-mono)", fontSize: 12,
                  padding: "4px 10px", borderRadius: 6,
                  background: "var(--alc-bg)", border: "1px solid var(--alc-hairline-2)", color: "var(--alc-fg-2)",
                }}>{r}</span>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Section>
  );
}

function CloudDeployTerminal() {
  return (
    <Section padding="0 32px 96px">
      <div style={{ maxWidth: 900, margin: "0 auto" }}>
        <div style={{ textAlign: "center", marginBottom: 32 }}>
          <Eyebrow>local dev & deploy</Eyebrow>
          <h2 className="alc-h2" style={{ margin: "12px 0 12px" }}>One program. One command. Any stage.</h2>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
          <Terminal title="~/my-app" content={`[d]$[/d] alchemy dev

[g]✓[/g] [b]Bucket[/b] [d](Cloudflare.R2Bucket)[/d] [g]created[/g] [d](local)[/d]
[g]✓[/g] [b]KV[/b]     [d](Cloudflare.KVNamespace)[/d] [g]created[/g] [d](local)[/d]
[g]✓[/g] [b]Api[/b]    [d](Cloudflare.Worker)[/d] [g]created[/g] [d](local)[/d]
[s2][d]• http://localhost:1337[/d]

[d]Watching for changes ...[/d]`} />
          <Terminal title="~/my-app" content={`[d]$[/d] alchemy deploy --stage prod

[u]Plan[/u]: [g]3 to create[/g]

[g]+[/g] [b]Bucket[/b] [d](Cloudflare.R2Bucket)[/d]
[g]+[/g] [b]KV[/b]     [d](Cloudflare.KVNamespace)[/d]
[g]+[/g] [b]Api[/b]    [d](Cloudflare.Worker)[/d] [c]2 bindings[/c]

Proceed? [g]◉[/g] Yes [d]○[/d] No

[g]✓[/g] deployed in [b]4.1s[/b]
[s2][g]→ https://api.my-app.workers.dev[/g]`} />
        </div>
      </div>
    </Section>
  );
}

function CloudCTA() {
  return (
    <Section padding="20px 32px 40px">
      <div style={{ textAlign: "center" }}>
        <h2 className="alc-h2" style={{ margin: "0 0 16px" }}>Ship your cloud as one typed program.</h2>
        <div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
          <Button variant="primary" icon="arrow">Start the tutorial</Button>
          <Button variant="secondary">Read the docs</Button>
          <Button variant="ghost" icon="github">GitHub</Button>
        </div>
      </div>
    </Section>
  );
}

Object.assign(window, {
  CloudHero, CloudStackExample, CloudResourcesAndWorker, CloudFeatureTabs,
  CloudIntegrationTests, CloudProviderGrid, CloudDeployTerminal, CloudCTA,
});
