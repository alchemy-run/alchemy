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
        <Eyebrow>plan · deploy · destroy</Eyebrow>
        <h2 className="alc-h2" style={{ margin: "12px 0 12px" }}>Plan, deploy, and destroy a Stack of resources.</h2>
        <p style={{ fontSize: 16, lineHeight: 1.65, color: "var(--alc-fg-2)", maxWidth: 640, margin: "12px auto 0" }}>
          A <code style={{ fontFamily: "var(--alc-font-mono)", fontSize: 14, color: "var(--alc-accent-deep)" }}>Stack</code> is an Effect that declares your resources. <code style={{ fontFamily: "var(--alc-font-mono)", fontSize: 14, color: "var(--alc-accent-deep)" }}>alchemy plan</code> previews the diff, <code style={{ fontFamily: "var(--alc-font-mono)", fontSize: 14, color: "var(--alc-accent-deep)" }}>deploy</code> applies it, and <code style={{ fontFamily: "var(--alc-font-mono)", fontSize: 14, color: "var(--alc-accent-deep)" }}>destroy</code> tears it back down — same program, full lifecycle.
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
            <SketchLabel>Stack</SketchLabel>
            <span>one TypeScript program</span>
          </div>
        </div>

        <div className="stack-deploy-diagram__bridge" aria-hidden="true">
          <span className="stack-deploy-diagram__label">plan · deploy · destroy</span>
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
        </div>

        <div className="stack-deploy-diagram__col">
          <DeployTerminal />
          <div className="stack-deploy-diagram__caption">
            <SketchLabel>Resources</SketchLabel>
            <span>live in your accounts</span>
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

// ---- Provider color palette + tints ----
const CF_COLOR  = "#F38020"; // Cloudflare orange
const AWS_COLOR = "#2563EB"; // bright blue — strong contrast with CF orange
// Tints used as icon-fill backgrounds (rgba so the background colour shows through).
const tint = (hex, a = 0.15) => {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return `rgba(${r},${g},${b},${a})`;
};

// ---- Inline SVG icons for the diagram nodes ----
// Each icon takes a `color` prop so we can tint by provider.

function IconClient({ size = 26 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden>
      <circle cx="16" cy="16" r="11" stroke="var(--alc-fg-3)" strokeWidth="1.4" />
      <ellipse cx="16" cy="16" rx="5" ry="11" stroke="var(--alc-fg-3)" strokeWidth="1.2" />
      <line x1="5" y1="16" x2="27" y2="16" stroke="var(--alc-fg-3)" strokeWidth="1.2" />
    </svg>
  );
}

function IconWorker({ size = 26, color = CF_COLOR }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden>
      <rect x="3" y="3" width="26" height="26" rx="6"
            fill={tint(color)} stroke={color} strokeWidth="1.4" />
      <path d="M19 7 L10 18 H15 L13 25 L22 13 H17 Z" fill={color} />
    </svg>
  );
}

function IconR2({ size = 26, color = CF_COLOR }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden>
      <ellipse cx="16" cy="9" rx="10" ry="3" fill={tint(color)} stroke={color} strokeWidth="1.5" />
      <path d="M6 9 V23 C6 24.7 10.5 26 16 26 C21.5 26 26 24.7 26 23 V9"
            fill={tint(color)} stroke={color} strokeWidth="1.5" />
      <path d="M6 16 C6 17.7 10.5 19 16 19 C21.5 19 26 17.7 26 16"
            stroke={color} strokeWidth="1" strokeOpacity="0.55" fill="none" />
    </svg>
  );
}

function IconKV({ size = 26, color = CF_COLOR }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden>
      <circle cx="11" cy="16" r="6" fill={tint(color)} stroke={color} strokeWidth="1.5" />
      <circle cx="11" cy="16" r="2.2" fill={color} />
      <path d="M17 16 L27 16 M23 16 L23 21 M27 16 L27 12"
            stroke={color} strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function IconDO({ size = 26, color = CF_COLOR }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden>
      <path d="M16 3 L28 10 L28 22 L16 29 L4 22 L4 10 Z"
            fill={tint(color)} stroke={color} strokeWidth="1.5" />
      <circle cx="16" cy="16" r="3.5" fill={color} />
    </svg>
  );
}

// D1 — relational/SQL: cylinder with horizontal lines suggesting rows
function IconD1({ size = 26, color = CF_COLOR }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden>
      <ellipse cx="16" cy="8" rx="10" ry="3" fill={tint(color)} stroke={color} strokeWidth="1.5" />
      <path d="M6 8 V24 C6 25.7 10.5 27 16 27 C21.5 27 26 25.7 26 24 V8"
            fill={tint(color)} stroke={color} strokeWidth="1.5" />
      <path d="M9 14 L23 14 M9 18 L23 18 M9 22 L19 22"
            stroke={color} strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

// Container — cube outline
function IconContainer({ size = 26, color = CF_COLOR }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden>
      <path d="M16 3 L27 9 V22 L16 28 L5 22 V9 Z"
            fill={tint(color)} stroke={color} strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M5 9 L16 15 L27 9 M16 15 V28"
            stroke={color} strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  );
}

// Lambda — λ in tinted square
function IconLambda({ size = 26, color = AWS_COLOR }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden>
      <rect x="3" y="3" width="26" height="26" rx="6"
            fill={tint(color)} stroke={color} strokeWidth="1.4" />
      <path d="M9 8 H13 L21 24 H17 L15 19 L11 24 H7 L13 16 L11 12 H9 Z"
            fill={color} />
    </svg>
  );
}

// DynamoDB — three stacked horizontal disks
function IconDynamoDB({ size = 26, color = AWS_COLOR }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden>
      <ellipse cx="16" cy="8"  rx="10" ry="3" fill={tint(color)} stroke={color} strokeWidth="1.4" />
      <ellipse cx="16" cy="16" rx="10" ry="3" fill={tint(color)} stroke={color} strokeWidth="1.4" />
      <ellipse cx="16" cy="24" rx="10" ry="3" fill={tint(color)} stroke={color} strokeWidth="1.4" />
    </svg>
  );
}

// S3 — bucket
function IconS3({ size = 26, color = AWS_COLOR }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden>
      <path d="M7 8 H25 L23 26 H9 Z"
            fill={tint(color)} stroke={color} strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M7 8 H25" stroke={color} strokeWidth="1.5" />
      <circle cx="22" cy="11.5" r="1.2" fill={color} />
    </svg>
  );
}

// IAM — shield
function IconIAM({ size = 26, color = AWS_COLOR }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden>
      <path d="M16 3 L27 7 V16 C27 22.5 22 27 16 29 C10 27 5 22.5 5 16 V7 Z"
            fill={tint(color)} stroke={color} strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M11 15 L15 19 L22 12" stroke={color} strokeWidth="1.8"
            fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ---- Node + connector primitives ----

function DiagNode({ icon, label, sub, accent, dim, color = CF_COLOR }) {
  return (
    <div style={{
      background: dim ? "var(--alc-bg)" : "var(--alc-bg-elev-1)",
      border: `1px solid ${accent ? color : "var(--alc-hairline-2)"}`,
      borderRadius: 10,
      padding: "10px 12px 8px",
      minWidth: 92,
      display: "flex", flexDirection: "column", alignItems: "center", gap: 4,
      boxShadow: accent ? `0 0 0 2px ${tint(color, 0.12)}` : "none",
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

// IAM-policy node — the visual centerpiece for AWS .bind() == IAM action mapping.
function DiagPolicy({ actions, color = AWS_COLOR }) {
  return (
    <div style={{
      background: "var(--alc-bg-elev-1)",
      border: `1px dashed ${color}`,
      borderRadius: 10,
      padding: "8px 12px",
      display: "flex", flexDirection: "column", alignItems: "center", gap: 4,
      minWidth: 160,
    }}>
      <div style={{
        display: "flex", alignItems: "center", gap: 6,
        fontFamily: "var(--alc-font-sans)", fontSize: 11.5, fontWeight: 600,
        color: "var(--alc-fg-2)",
      }}>
        <IconIAM size={16} color={color} />
        <span>IAM Policy</span>
        <span style={{
          fontFamily: "var(--alc-font-mono)", fontSize: 10,
          color: "var(--alc-fg-4)", fontWeight: 400,
        }}>auto</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 3, alignItems: "center" }}>
        {actions.map((a) => (
          <span key={a} style={{
            fontFamily: "var(--alc-font-mono)", fontSize: 10.5,
            padding: "2px 8px", borderRadius: 4,
            background: tint(color, 0.1), color: "var(--alc-fg-2)",
          }}>{a}</span>
        ))}
      </div>
    </div>
  );
}

function DiagArrow({ label, height = 22, color = CF_COLOR }) {
  return (
    <div style={{
      display: "flex", flexDirection: "column", alignItems: "center",
      gap: 2, padding: "2px 0",
    }}>
      {label && (
        <div style={{ fontFamily: "var(--alc-font-mono)", fontSize: 10, color: "var(--alc-fg-3)" }}>
          {label}
        </div>
      )}
      <svg width="14" height={height} viewBox={`0 0 14 ${height}`}>
        <path d={`M7 0 L7 ${height - 6}`} stroke={color} strokeWidth="1.4" />
        <path d={`M3 ${height - 8} L7 ${height - 1} L11 ${height - 8}`}
          stroke={color} strokeWidth="1.4" fill="none"
          strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  );
}

// Bidirectional arrow (one up + one down, side-by-side) with optional labels.
function DiagBidir({ topLabel, bottomLabel, height = 30, color = CF_COLOR }) {
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
        <path d={`M9 ${height - 1} L9 5`} stroke={color} strokeWidth="1.4" />
        <path d={`M6 7 L9 1 L12 7`} stroke={color} strokeWidth="1.4" fill="none"
          strokeLinecap="round" strokeLinejoin="round" />
        <path d={`M19 1 L19 ${height - 5}`} stroke={color} strokeWidth="1.4" />
        <path d={`M16 ${height - 7} L19 ${height - 1} L22 ${height - 7}`}
          stroke={color} strokeWidth="1.4" fill="none"
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
function DiagFanOut({ parent, children: kids, label, color = CF_COLOR }) {
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
      <div style={{ position: "relative", height: 28, width: "100%", marginTop: 2 }}>
        <div style={{
          position: "absolute", left: "50%", top: 0, height: 9, width: 0,
          borderLeft: `1.4px solid ${color}`, transform: "translateX(-0.5px)",
        }} />
        <div style={{
          position: "absolute", top: 8, left: `${startPct}%`, right: `${startPct}%`,
          borderTop: `1.4px solid ${color}`,
        }} />
        {kids.map((_, i) => {
          const x = `${startPct * (2 * i + 1)}%`;
          return (
            <React.Fragment key={i}>
              <div style={{
                position: "absolute", top: 9, left: x, height: 14, width: 0,
                borderLeft: `1.4px solid ${color}`, transform: "translateX(-0.5px)",
              }} />
              <svg width="8" height="6" style={{
                position: "absolute", top: 22, left: x, transform: "translateX(-4px)",
              }}>
                <path d="M0 0 L4 6 L8 0" stroke={color} strokeWidth="1.4"
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

// Cloudflare: Linear · Client → Worker → Bucket
function DiagramR2() {
  return (
    <DiagWrap>
      <DiagNode icon={<IconClient />} label="Client" sub="HTTP" dim />
      <DiagArrow label="GET /key" color={CF_COLOR} />
      <DiagNode icon={<IconWorker color={CF_COLOR} />} label="Api" sub="Worker" accent color={CF_COLOR} />
      <DiagArrow label=".bind(Bucket)" color={CF_COLOR} />
      <DiagNode icon={<IconR2 color={CF_COLOR} />} label="Bucket" sub="R2" />
    </DiagWrap>
  );
}

// Cloudflare: Bidirectional · Worker ↔ KV
function DiagramKV() {
  return (
    <DiagWrap>
      <DiagNode icon={<IconWorker color={CF_COLOR} />} label="Api" sub="Worker" accent color={CF_COLOR} />
      <DiagBidir topLabel="kv.put(k, v)" bottomLabel="kv.get(k)" height={36} color={CF_COLOR} />
      <DiagNode icon={<IconKV color={CF_COLOR} />} label="KV" sub="key/value" />
    </DiagWrap>
  );
}

// Cloudflare: Two-stage · Worker → D1 → SQL
function DiagramD1() {
  return (
    <DiagWrap>
      <DiagNode icon={<IconWorker color={CF_COLOR} />} label="Api" sub="Worker" accent color={CF_COLOR} />
      <DiagArrow label="D1Connection.bind(DB)" color={CF_COLOR} />
      <DiagNode icon={<IconD1 color={CF_COLOR} />} label="DB" sub="D1Database" />
      <DiagArrow label='.prepare("SELECT …")' color={CF_COLOR} />
      <DiagNode label="rows" sub="typed result" dim />
    </DiagWrap>
  );
}

// Cloudflare: Fan-out · Worker routes by name to many Room instances
function DiagramRoom() {
  return (
    <DiagWrap>
      <DiagFanOut
        color={CF_COLOR}
        parent={<DiagNode icon={<IconWorker color={CF_COLOR} />} label="Api" sub="Worker" accent color={CF_COLOR} />}
        label="rooms.getByName(id)"
        children={[
          <DiagNode icon={<IconDO color={CF_COLOR} />} label="Room" sub="#alpha" />,
          <DiagNode icon={<IconDO color={CF_COLOR} />} label="Room" sub="#beta" />,
          <DiagNode icon={<IconDO color={CF_COLOR} />} label="Room" sub="#gamma" />,
        ]}
      />
    </DiagWrap>
  );
}

// Cloudflare: Nested · Worker → DO → Container
function DiagramContainer() {
  return (
    <DiagWrap>
      <DiagNode icon={<IconDO color={CF_COLOR} />} label="Agent" sub="DurableObject" accent color={CF_COLOR} />
      <DiagArrow label="Container.bind(Sandbox)" color={CF_COLOR} />
      <DiagNode icon={<IconContainer color={CF_COLOR} />} label="Sandbox" sub="Cloudflare.Container" />
      <DiagArrow label="container.fetch(req)" color={CF_COLOR} />
      <DiagNode label=":3000" sub="HTTP server" dim />
    </DiagWrap>
  );
}

// AWS: 1:1 · Lambda → IAM Policy (auto, 2 actions) → DynamoDB
function DiagramLambdaDynamo() {
  return (
    <DiagWrap>
      <DiagNode icon={<IconLambda color={AWS_COLOR} />} label="JobFunction" sub="AWS.Lambda" accent color={AWS_COLOR} />
      <DiagArrow label=".bind(table) ×2" color={AWS_COLOR} />
      <DiagPolicy actions={["dynamodb:GetItem", "dynamodb:PutItem"]} color={AWS_COLOR} />
      <DiagArrow color={AWS_COLOR} />
      <DiagNode icon={<IconDynamoDB color={AWS_COLOR} />} label="JobsTable" sub="DynamoDB.Table" />
    </DiagWrap>
  );
}

// AWS: 1:1 · Lambda → IAM Policy (auto, 2 actions) → S3
function DiagramLambdaS3() {
  return (
    <DiagWrap>
      <DiagNode icon={<IconLambda color={AWS_COLOR} />} label="ImageFn" sub="AWS.Lambda" accent color={AWS_COLOR} />
      <DiagArrow label=".bind(bucket) ×2" color={AWS_COLOR} />
      <DiagPolicy actions={["s3:GetObject", "s3:PutObject"]} color={AWS_COLOR} />
      <DiagArrow color={AWS_COLOR} />
      <DiagNode icon={<IconS3 color={AWS_COLOR} />} label="Photos" sub="S3.Bucket" />
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

const SRC_D1 = `import { DB } from "./DB.ts";

export default class Api extends Cloudflare.Worker<Api>()(
  "Api",
  Effect.gen(function* () {
    const db = yield* Cloudflare.D1Connection.bind(DB);
    return {
      fetch: () => db.prepare("SELECT * FROM users").all(),
    };
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

const SRC_CONTAINER = `import { Sandbox } from "./Sandbox.ts";

export default class Agent extends Cloudflare.DurableObjectNamespace<Agent>()(
  "Agents",
  Effect.gen(function* () {
    const sandbox = yield* Cloudflare.Container.bind(Sandbox);
    const container = yield* Cloudflare.start(sandbox);
    return { fetch: (req) => container.fetch(req) };
  }),
) {}
`;

const SRC_LAMBDA_DYNAMO = `import { Jobs } from "./Jobs.ts";

export default class JobFunction extends AWS.Lambda.Function<JobFunction>()(
  "JobFunction",
  Effect.gen(function* () {
    const get = yield* AWS.DynamoDB.GetItem.bind(Jobs);
    const put = yield* AWS.DynamoDB.PutItem.bind(Jobs);
    return { fetch: (req) => get({ Key: { id: { S: req.url } } }) };
  }),
) {}
`;

const SRC_LAMBDA_S3 = `import { Photos } from "./Photos.ts";

export default class ImageFn extends AWS.Lambda.Function<ImageFn>()(
  "ImageFn",
  Effect.gen(function* () {
    const get = yield* AWS.S3.GetObject.bind(Photos);
    const put = yield* AWS.S3.PutObject.bind(Photos);
    return { fetch: (req) => get({ Key: req.url }) };
  }),
) {}
`;

// Tabs for Cloudflare feature breadth — full export defaults, side-by-side diagrams.
function CloudFeatureTabs() {
  const [tab, setTab] = useState3("r2");
  const examples = [
    // Cloudflare
    {
      k: "r2", provider: "cf", label: "R2",
      filename: "src/Api.ts",
      caption: "Bind an R2 bucket inside a Worker — typed client, deploy-time wiring.",
      src: SRC_R2, diagram: <DiagramR2 />,
    },
    {
      k: "kv", provider: "cf", label: "KV",
      filename: "src/Api.ts",
      caption: "Same .bind() shape — get and put from one typed client.",
      src: SRC_KV, diagram: <DiagramKV />,
    },
    {
      k: "d1", provider: "cf", label: "D1",
      filename: "src/Api.ts",
      caption: "A serverless SQL database, prepared statements, all typed.",
      src: SRC_D1, diagram: <DiagramD1 />,
    },
    {
      k: "do", provider: "cf", label: "Durable Object",
      filename: "src/Api.ts",
      caption: "Yield the Room namespace, then route by name — one DO instance per id.",
      src: SRC_DO, diagram: <DiagramRoom />,
    },
    {
      k: "ctr", provider: "cf", label: "Container",
      filename: "src/Agent.ts",
      caption: "Bind a Container from a Durable Object, start it, speak HTTP to its ports.",
      src: SRC_CONTAINER, diagram: <DiagramContainer />,
    },
    // AWS — each .bind() compiles to a single IAM action on the Lambda role.
    {
      k: "ddb", provider: "aws", label: "Lambda + DynamoDB",
      filename: "src/JobFunction.ts",
      caption: "Each .bind() compiles to exactly one IAM action — no policy JSON to maintain.",
      src: SRC_LAMBDA_DYNAMO, diagram: <DiagramLambdaDynamo />,
    },
    {
      k: "s3", provider: "aws", label: "Lambda + S3",
      filename: "src/ImageFn.ts",
      caption: "Same shape, S3. Two binds, two actions, zero hand-written policy.",
      src: SRC_LAMBDA_S3, diagram: <DiagramLambdaS3 />,
    },
  ];
  const providerColor = (p) => p === "aws" ? AWS_COLOR : CF_COLOR;
  const active = examples.find(e => e.k === tab) || examples[0];

  return (
    <Section padding="80px 32px" maxWidth={1040}>
      <div style={{ textAlign: "center", marginBottom: 36 }}>
        <Eyebrow>bindings · the same shape, every primitive</Eyebrow>
        <h2 className="alc-h2" style={{ margin: "12px 0 12px" }}>Typed all the way down.</h2>
        <p style={{ fontSize: 16, lineHeight: 1.65, color: "var(--alc-fg-2)", maxWidth: 660, margin: "12px auto 0" }}>
          Declare a resource once. Bind it inside a Worker or a Lambda — the runtime client is typed,
          the deploy-time wiring is automatic. On AWS, every <code style={{ fontFamily: "var(--alc-font-mono)", fontSize: 14, color: "var(--alc-accent-deep)" }}>.bind()</code> compiles to a single IAM action: least-privilege by construction.
        </p>
      </div>

      <div style={{
        display: "flex", justifyContent: "center", alignItems: "center",
        gap: 4, marginBottom: 18, flexWrap: "wrap",
      }}>
        {examples.map((t, i) => {
          const c = providerColor(t.provider);
          const active = tab === t.k;
          const prev = examples[i - 1];
          const groupBreak = prev && prev.provider !== t.provider;
          return (
            <React.Fragment key={t.k}>
              {groupBreak && (
                <span aria-hidden style={{
                  width: 1, height: 18,
                  background: "var(--alc-hairline-2)", margin: "0 6px",
                }} />
              )}
              <button onClick={() => setTab(t.k)} style={{
                border: `1px solid ${active ? c : "var(--alc-hairline-2)"}`,
                background: active ? "var(--alc-bg-code)" : "var(--alc-bg-elev-1)",
                color: active ? "var(--alc-fg-invert)" : "var(--alc-fg-2)",
                fontFamily: "var(--alc-font-mono)", fontSize: 12.5,
                padding: "7px 14px", borderRadius: 8, cursor: "pointer",
                display: "inline-flex", alignItems: "center", gap: 7,
                boxShadow: active ? `0 0 0 2px ${tint(c, 0.18)}` : "none",
              }}>
                <span aria-hidden style={{
                  width: 7, height: 7, borderRadius: "50%", background: c,
                  flex: "0 0 auto",
                }} />
                {t.label}
              </button>
            </React.Fragment>
          );
        })}
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
            <TestTerminal title="CI · pr-1729" />
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
  const features = [
    {
      t: "Local emulation, real bindings",
      d: "Workers, R2, KV, D1, Queues — all run in-process. Your .bind() clients hit the local emulator, with the same types you'll get in production.",
    },
    {
      t: "Hot reload in milliseconds",
      d: "Edit a Worker handler, save, and the running instance swaps in under 100ms. State on bound resources persists across reloads.",
    },
    {
      t: "Resource graph hot deploys",
      d: "Add a Queue or change a binding and alchemy detects the diff, spins up the new resource locally, and rewires the Worker — no restart.",
    },
  ];
  return (
    <Section padding="0 32px 96px">
      <div style={{ maxWidth: 980, margin: "0 auto" }}>
        <div style={{ textAlign: "center", marginBottom: 32 }}>
          <Eyebrow>local emulation · hot reload · hot deploys</Eyebrow>
          <h2 className="alc-h2" style={{ margin: "12px 0 12px" }}>
            <code style={{ fontFamily: "var(--alc-font-mono)", fontSize: "0.92em", color: "var(--alc-accent-deep)" }}>alchemy dev</code> — your whole stack, live in your terminal.
          </h2>
          <p style={{ fontSize: 16, lineHeight: 1.65, color: "var(--alc-fg-2)", maxWidth: 640, margin: "12px auto 0" }}>
            Run one command. alchemy boots a local emulator for every resource, watches your source graph, and hot-reloads Workers — and the resources behind them — the moment you save.
          </p>
        </div>
        <div style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 1.25fr) minmax(0, 1fr)",
          gap: 24, alignItems: "start",
        }}>
          <DevTerminal title="~/my-app" />
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {features.map((f) => (
              <div key={f.t} style={{
                background: "var(--alc-bg-elev-1)",
                border: "1px solid var(--alc-hairline)",
                borderRadius: 10, padding: 18,
              }}>
                <div style={{
                  fontFamily: "var(--alc-font-sans)", fontSize: 15, fontWeight: 600,
                  color: "var(--alc-fg-1)", marginBottom: 6,
                }}>{f.t}</div>
                <div style={{ fontSize: 13, lineHeight: 1.6, color: "var(--alc-fg-3)" }}>{f.d}</div>
              </div>
            ))}
          </div>
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

// ---------------------------------------------------------------------------
// CloudLayers — components packaged as Layers, with swappable backends
// ---------------------------------------------------------------------------

// Generic stacked-layers icon used for the morphing "Layer" node.
function IconLayerStack({ size = 26, color = CF_COLOR }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden>
      <path d="M16 4 L28 10 L16 16 L4 10 Z"
            fill={tint(color)} stroke={color} strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M4 16 L16 22 L28 16" stroke={color} strokeWidth="1.4"
            fill="none" strokeLinejoin="round" opacity="0.85" />
      <path d="M4 22 L16 28 L28 22" stroke={color} strokeWidth="1.4"
            fill="none" strokeLinejoin="round" opacity="0.55" />
    </svg>
  );
}

function CloudLayers() {
  // The set of swappable Layers we cycle through. Each entry drives the
  // highlighted token in the code panel AND the morphing nodes in the diagram.
  const layers = [
    { k: "kv",  layerName: "SessionsKV",       resourceLabel: "KVNamespace",    resourceSub: "Cloudflare KV",  bind: ".bind(ns)",     icon: <IconKV color={CF_COLOR} />,           color: CF_COLOR  },
    { k: "ddb", layerName: "SessionsDynamoDB", resourceLabel: "DynamoDB.Table", resourceSub: "AWS DynamoDB",   bind: ".bind(table)",  icon: <IconDynamoDB color={AWS_COLOR} />,    color: AWS_COLOR },
    { k: "d1",  layerName: "SessionsD1",       resourceLabel: "D1Database",     resourceSub: "Cloudflare D1",  bind: ".bind(db)",     icon: <IconD1 color={CF_COLOR} />,           color: CF_COLOR  },
  ];
  const [idx, setIdx] = useState3(0);
  const active = layers[idx];
  const next = (e) => {
    // The code-token element drives advancement; ignore stray bubbled events.
    if (!e || e.animationName === "layer-cycle") {
      setIdx((i) => (i + 1) % layers.length);
    }
  };

  const integrations = [
    {
      name: "@alchemy/better-auth",
      status: "available",
      desc: "Drop-in Better Auth, packaged as a Layer. Resources, secrets, and routes are wired by the Layer you pick.",
      backends: ["CloudflareD1", "Planetscale (soon)", "DynamoDB (soon)"],
      snippet: `import { CloudflareD1 } from "@alchemy/better-auth/CloudflareD1";

Effect.provide(CloudflareD1);`,
    },
    {
      name: "@alchemy/inngest",
      status: "planned",
      desc: "Durable workflows as a Layer. The Layer provisions the event source, registers your functions, and gives you a typed client to send events.",
      backends: ["Cloudflare", "AWS Lambda", "Self-hosted"],
      snippet: `import { Inngest } from "@alchemy/inngest/Cloudflare";

Effect.provide(Inngest);`,
    },
    {
      name: "@alchemy/electric",
      status: "planned",
      desc: "ElectricSQL local-first sync, packaged whole: Postgres, the sync service, and a typed client — all from one Layer.",
      backends: ["Cloudflare + Neon", "AWS + RDS", "Self-hosted"],
      snippet: `import { Electric } from "@alchemy/electric/Cloudflare";

Effect.provide(Electric);`,
    },
  ];

  return (
    <Section padding="80px 32px" maxWidth={1100}>
      {/* Block A — intro */}
      <div style={{ textAlign: "center", marginBottom: 40 }}>
        <Eyebrow>cloud services · interface + layer, distributed on npm</Eyebrow>
        <h2 className="alc-h2" style={{ margin: "12px 0 12px" }}>
          Cloud services, as <span style={{ fontStyle: "italic", color: "var(--alc-accent-deep)" }}>libraries</span>.
        </h2>
        <p style={{ fontSize: 16, lineHeight: 1.65, color: "var(--alc-fg-2)", maxWidth: 740, margin: "12px auto 0" }}>
          A cloud service is a <code style={{ fontFamily: "var(--alc-font-mono)", fontSize: 14, color: "var(--alc-accent-deep)" }}>Context.Service</code> interface that any Effect <code style={{ fontFamily: "var(--alc-font-mono)", fontSize: 14, color: "var(--alc-accent-deep)" }}>Layer</code> can implement. Layers bundle infrastructure declarations <em>and</em> the runtime client into a single TypeScript module — <code style={{ fontFamily: "var(--alc-font-mono)", fontSize: 14, color: "var(--alc-accent-deep)" }}>npm install</code> the service, <code style={{ fontFamily: "var(--alc-font-mono)", fontSize: 14, color: "var(--alc-accent-deep)" }}>Effect.provide</code> a Layer, and the resources, bindings, and typed client wire themselves up.
        </p>
      </div>

      {/* Block B — animated Layer swap */}
      <div className="layers-swap-grid">
        <CodeBlock filename="src/Api.ts">
{T.k("export default")} {T.k("class")} {T.t("Api")} {T.k("extends")} {T.v("Cloudflare")}.{T.f("Worker")}{"<"}{T.t("Api")}{">()"}({"\n"}
{"  "}{T.s('"Api"')},{"\n"}
{"  "}{T.v("Effect")}.{T.f("gen")}({T.k("function")}* () {"{"}{"\n"}
{"    "}{T.k("const")} sessions = {T.k("yield")}* {T.v("Sessions")};{"\n"}
{"    "}{T.k("return")} {"{ fetch: /* uses sessions */ };"}{"\n"}
{"  "}{"}).pipe("}{"\n"}
{"    "}{T.c("// swap one Layer — the resource graph swaps with it")}{"\n"}
{"    "}{T.v("Effect")}.{T.f("provide")}(<span
            key={idx}
            className="layer-swap"
            onAnimationEnd={next}
            style={{ color: active.color, fontWeight: 600 }}
          >
            {active.layerName}
          </span>),{"\n"}
{"  "}{"),"}{"\n"}
{") {"}{"}"}
        </CodeBlock>

        <div style={{
          background: "var(--alc-bg-elev-1)",
          border: "1px solid var(--alc-hairline)",
          borderRadius: 10, padding: "18px 14px",
          display: "flex", alignItems: "center", justifyContent: "center",
          minHeight: 320,
        }}>
          <DiagWrap>
            <DiagNode
              label="Sessions"
              sub="Context.Service"
              accent
              color="var(--alc-accent-deep)"
              icon={
                <svg width="26" height="26" viewBox="0 0 32 32" fill="none" aria-hidden>
                  <rect x="4" y="6" width="24" height="20" rx="4"
                        fill="rgba(184,138,74,0.15)" stroke="var(--alc-accent-deep)" strokeWidth="1.5" />
                  <path d="M9 13 H23 M9 17 H19 M9 21 H21"
                        stroke="var(--alc-accent-deep)" strokeWidth="1.4" strokeLinecap="round" />
                </svg>
              }
            />
            <div key={`a1-${idx}`} className="layer-swap-edge">
              <DiagArrow label="Layer.effect" color={active.color} />
            </div>
            <div key={`l-${idx}`} className="layer-swap-node">
              <DiagNode
                label={active.layerName}
                sub="Layer"
                accent
                color={active.color}
                icon={<IconLayerStack color={active.color} />}
              />
            </div>
            <div key={`a2-${idx}`} className="layer-swap-edge">
              <DiagArrow label={active.bind} color={active.color} />
            </div>
            <div key={`r-${idx}`} className="layer-swap-node">
              <DiagNode
                icon={active.icon}
                label={active.resourceLabel}
                sub={active.resourceSub}
                color={active.color}
              />
            </div>
          </DiagWrap>
        </div>
      </div>

      <div style={{
        textAlign: "center", maxWidth: 720, margin: "20px auto 0",
        fontSize: 13.5, color: "var(--alc-fg-3)", lineHeight: 1.6,
      }}>
        One <code style={{ fontFamily: "var(--alc-font-mono)", fontSize: 12.5, color: "var(--alc-accent-deep)" }}>Effect.provide</code> call swaps the Layer — and the whole resource graph swaps with it. The <code style={{ fontFamily: "var(--alc-font-mono)", fontSize: 12.5, color: "var(--alc-accent-deep)" }}>Sessions</code> consumer never changes.
      </div>

      {/* Block C — integrations */}
      <div style={{ textAlign: "center", marginTop: 72, marginBottom: 28 }}>
        <Eyebrow>integrations · SaaS shipped as layers</Eyebrow>
        <h3 style={{
          fontFamily: "var(--alc-font-serif)", fontWeight: 500,
          fontSize: 36, lineHeight: 1.1, letterSpacing: "-0.01em",
          margin: "10px 0 10px", color: "var(--alc-fg-1)",
        }}>
          <span style={{ fontStyle: "italic", color: "var(--alc-accent-deep)" }}>Install</span> the infrastructure you need.
        </h3>
        <p style={{ fontSize: 15, lineHeight: 1.6, color: "var(--alc-fg-2)", maxWidth: 640, margin: "8px auto 0" }}>
          Real services — Better Auth, Drizzle, queues — packaged as Alchemy Layers on npm. Each Layer brings its own resources, bindings, and typed client. Pick a backend, provide the Layer, ship.
        </p>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16 }}>
        {integrations.map(i => {
          const isAvail = i.status === "available";
          return (
            <div key={i.name} style={{
              background: "var(--alc-bg-elev-1)",
              border: "1px solid var(--alc-hairline)",
              borderRadius: 12, padding: 22,
              display: "flex", flexDirection: "column", gap: 12,
            }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                <div style={{
                  fontFamily: "var(--alc-font-mono)", fontSize: 13.5, fontWeight: 600,
                  color: "var(--alc-fg-1)", overflow: "hidden", textOverflow: "ellipsis",
                }}>{i.name}</div>
                <span style={{
                  fontFamily: "var(--alc-font-mono)", fontSize: 10,
                  letterSpacing: "0.08em", textTransform: "uppercase",
                  padding: "3px 8px", borderRadius: 4,
                  background: isAvail ? "rgba(115,158,75,0.16)" : "var(--alc-bg)",
                  color: isAvail ? "var(--alc-success)" : "var(--alc-fg-4)",
                  border: `1px solid ${isAvail ? "rgba(115,158,75,0.4)" : "var(--alc-hairline-2)"}`,
                  whiteSpace: "nowrap",
                }}>{isAvail ? "available" : "planned"}</span>
              </div>
              <div style={{ fontSize: 13, lineHeight: 1.55, color: "var(--alc-fg-3)" }}>{i.desc}</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                {i.backends.map(b => (
                  <span key={b} style={{
                    fontFamily: "var(--alc-font-mono)", fontSize: 11,
                    padding: "3px 8px", borderRadius: 5,
                    background: "var(--alc-bg)",
                    border: "1px solid var(--alc-hairline-2)",
                    color: "var(--alc-fg-2)",
                  }}>{b}</span>
                ))}
              </div>
              <pre style={{
                margin: 0, padding: "10px 12px",
                background: "var(--alc-bg-code)",
                border: "1px solid var(--alc-hairline)",
                borderRadius: 8,
                fontFamily: "var(--alc-font-mono)", fontSize: 11.5, lineHeight: 1.6,
                color: "var(--alc-code-var)", overflowX: "auto",
              }}>{highlightTS(i.snippet)}</pre>
            </div>
          );
        })}
      </div>
    </Section>
  );
}

Object.assign(window, {
  CloudHero, CloudStackExample, CloudResourcesAndWorker, CloudFeatureTabs,
  CloudLayers,
  CloudIntegrationTests, CloudProviderGrid, CloudDeployTerminal, CloudCTA,
});
