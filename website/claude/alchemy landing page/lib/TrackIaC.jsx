// Track 2: IaC comparison — "just typescript, fast, embeddable, extensible"
// Layout: performance-forward hero, big comparison table, extension code example, speed chart

function IaCHero() {
  return (
    <Section padding="80px 32px 40px">
      <div style={{ textAlign: "center", marginBottom: 28 }}>
        <AlphaBadge />
      </div>
      <div style={{ textAlign: "center", maxWidth: 840, margin: "0 auto" }}>
        <Eyebrow>the iac engine that doesn't fight you</Eyebrow>
        <h1 style={{
          fontFamily: "var(--alc-font-serif)", fontWeight: 500,
          fontSize: 80, lineHeight: 1.02, letterSpacing: "-0.025em",
          margin: "18px 0 20px", color: "var(--alc-fg-1)",
        }}>
          Infrastructure as code,<br/>
          <span style={{ color: "var(--alc-accent-deep)", fontStyle: "italic" }}>just TypeScript</span>.
        </h1>
        <p style={{
          fontSize: 20, lineHeight: 1.55, color: "var(--alc-fg-2)",
          maxWidth: 680, margin: "0 auto 32px",
        }}>
          No Terraform core. No CloudFormation service. No Go shim.
          Pure TypeScript on top of Effect — so alchemy is fast, embeddable,
          and trivial to extend.
        </p>
        <div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
          <Button variant="primary" icon="arrow">Read the tutorial</Button>
          <Button variant="secondary">Compare to Pulumi</Button>
          <Button variant="ghost" icon="github">GitHub</Button>
        </div>
      </div>

      {/* Quick stats strip */}
      <div style={{
        marginTop: 56,
        display: "grid", gridTemplateColumns: "repeat(4, 1fr)",
        gap: 1, background: "var(--alc-hairline-2)",
        border: "1px solid var(--alc-hairline-2)",
        borderRadius: 12, overflow: "hidden",
      }}>
        {[
          { n: "0", l: "Go binaries", s: "it's just a node package" },
          { n: "< 2s", l: "cold plan", s: "no state service roundtrip" },
          { n: "1", l: "resource = 1 file", s: "no schemas, no codegen" },
          { n: "100%", l: "TypeScript", s: "extend with imports" },
        ].map((s, i) => (
          <div key={i} style={{ background: "var(--alc-bg)", padding: "22px 24px" }}>
            <div style={{ fontFamily: "var(--alc-font-serif)", fontSize: 42, fontWeight: 500, color: "var(--alc-fg-1)", letterSpacing: "-0.02em", lineHeight: 1 }}>
              {s.n}
            </div>
            <div style={{ fontFamily: "var(--alc-font-mono)", fontSize: 11, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--alc-accent-deep)", marginTop: 6 }}>
              {s.l}
            </div>
            <div style={{ fontSize: 13, color: "var(--alc-fg-3)", marginTop: 6, lineHeight: 1.5 }}>
              {s.s}
            </div>
          </div>
        ))}
      </div>
    </Section>
  );
}

function IaCComparisonTable() {
  const cols = ["alchemy", "Pulumi", "SST", "Terraform", "AWS CDK"];
  const rows = [
    ["runtime", ["Node / Bun / Deno", "Go + Node bridge", "Node + SST Ion (Go)", "Go binary", "Node + CFN service"]],
    ["core engine", ["pure TypeScript", "Go", "Go (Ion)", "Go", "managed (CloudFormation)"]],
    ["cold plan (10 resources)", ["~ 1.8s", "~ 7s", "~ 5s", "~ 4s", "~ 60s (CFN)"]],
    ["state", ["typed, file/S3/DO", "managed cloud or file", "managed cloud or file", "tfstate", "CloudFormation stack"]],
    ["embed in your app?", ["yes", "no", "no", "no", "no"]],
    ["add a new resource", ["one TS file", "plugin + codegen", "plugin", "provider (Go)", "new L1 construct"]],
    ["runtime + infra same type-check?", ["yes", "no", "partial", "no", "no"]],
    ["async providers (plain async/await or Effect)", ["native", "awkward", "awkward", "no", "no"]],
    ["retries / error model", ["Effect-native", "custom", "custom", "CLI-level retries", "CFN timeouts"]],
    ["observability (OTEL)", ["built-in", "—", "—", "—", "—"]],
    ["destroy semantics", ["per-resource RemovalPolicy", "protect / retain", "retain", "prevent_destroy", "deletionPolicy"]],
    ["vendor lock-in", ["none", "Pulumi cloud default", "SST Console", "HashiCorp direction", "AWS only"]],
  ];
  const Check = ({ kind }) => {
    const map = {
      yes: { color: "var(--alc-success)", sym: "●" },
      partial: { color: "var(--alc-warn)", sym: "◐" },
      no: { color: "var(--alc-danger)", sym: "○" },
    };
    const s = map[kind];
    return <span style={{ color: s.color, fontSize: 13, marginRight: 6 }}>{s.sym}</span>;
  };

  // helper to classify simple yes/no cells
  const classify = (v, colIndex) => {
    if (v === "yes") return <><Check kind="yes" />yes</>;
    if (v === "no" || v === "—") return <><Check kind="no" />{v === "—" ? "—" : "no"}</>;
    if (v === "partial") return <><Check kind="partial" />partial</>;
    if (v === "native") return <><Check kind="yes" />native</>;
    if (v === "built-in") return <><Check kind="yes" />built-in</>;
    return <span>{v}</span>;
  };

  return (
    <Section padding="96px 32px" style={{ background: "var(--alc-bg-elev-1)", borderTop: "1px solid var(--alc-hairline)", borderBottom: "1px solid var(--alc-hairline)" }}>
      <div style={{ textAlign: "center", marginBottom: 48 }}>
        <Eyebrow>head to head</Eyebrow>
        <h2 className="alc-h2" style={{ margin: "12px 0 12px" }}>
          Same cloud. Different foundations.
        </h2>
        <p style={{ fontSize: 15, color: "var(--alc-fg-3)", maxWidth: 640, margin: "0 auto" }}>
          Other tools are Go cores with TypeScript paint. alchemy is TypeScript all the way
          down — so you can read it, fork it, and ship it inside your own CLI.
        </p>
      </div>

      <div style={{
        background: "var(--alc-bg)",
        border: "1px solid var(--alc-hairline-2)",
        borderRadius: 12, overflow: "hidden",
      }}>
        <div style={{
          display: "grid", gridTemplateColumns: `1.4fr repeat(${cols.length}, 1fr)`,
          padding: "14px 20px",
          background: "var(--alc-bg-sunk)",
          borderBottom: "1px solid var(--alc-hairline-2)",
          fontFamily: "var(--alc-font-mono)", fontSize: 11,
          letterSpacing: "0.1em", textTransform: "uppercase",
          color: "var(--alc-fg-4)",
        }}>
          <span></span>
          {cols.map((c, i) => (
            <span key={c} style={{
              color: i === 0 ? "var(--alc-accent-deep)" : "var(--alc-fg-4)",
              fontWeight: i === 0 ? 600 : 500,
            }}>{c}</span>
          ))}
        </div>
        {rows.map((r, i) => (
          <div key={i} style={{
            display: "grid", gridTemplateColumns: `1.4fr repeat(${cols.length}, 1fr)`,
            padding: "13px 20px", gap: 10,
            borderBottom: i === rows.length - 1 ? "none" : "1px solid var(--alc-hairline)",
            alignItems: "center",
            fontSize: 13.5,
            background: i % 2 === 1 ? "var(--alc-bg-elev-1)" : "transparent",
          }}>
            <span style={{ color: "var(--alc-fg-1)", fontWeight: 500, fontFamily: "var(--alc-font-mono)", fontSize: 12 }}>{r[0]}</span>
            {r[1].map((v, j) => (
              <span key={j} style={{
                color: j === 0 ? "var(--alc-fg-1)" : "var(--alc-fg-2)",
                fontWeight: j === 0 ? 600 : 400,
              }}>
                {classify(v, j)}
              </span>
            ))}
          </div>
        ))}
      </div>
      <div style={{ marginTop: 16, fontSize: 12, color: "var(--alc-fg-4)", fontFamily: "var(--alc-font-mono)" }}>
        * plan times measured against a 10-resource Cloudflare stack, warm credentials, no state backend roundtrip for alchemy. Your mileage will vary.
      </div>
    </Section>
  );
}

function IaCSpeedChart() {
  const data = [
    { name: "alchemy", v: 1.8, color: "var(--alc-accent)" },
    { name: "Terraform", v: 4.0, color: "var(--alc-walnut-400)" },
    { name: "SST", v: 5.1, color: "var(--alc-walnut-400)" },
    { name: "Pulumi", v: 7.2, color: "var(--alc-walnut-400)" },
    { name: "CDK (CFN)", v: 62, color: "var(--alc-walnut-500)" },
  ];
  const max = Math.max(...data.map(d => d.v));
  return (
    <Section padding="96px 32px">
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1.3fr", gap: 56, alignItems: "center" }}>
        <div>
          <Eyebrow>performance</Eyebrow>
          <h2 className="alc-h2" style={{ margin: "12px 0 16px" }}>Plan in under two seconds.</h2>
          <p style={{ fontSize: 16, lineHeight: 1.7, color: "var(--alc-fg-2)" }}>
            A Go binary still has to parse your config, fetch state, diff providers,
            and print a plan. alchemy skips the binary. The plan <i>is</i> a dry-run
            of your program.
          </p>
          <p style={{ fontSize: 16, lineHeight: 1.7, color: "var(--alc-fg-2)" }}>
            Resources run concurrently by default — they're Effects. Independent
            resources plan in parallel without any <code style={{ fontFamily: "var(--alc-font-mono)", fontSize: 14 }}>-parallelism 10</code> flag.
          </p>
          <div style={{ marginTop: 20, fontFamily: "var(--alc-font-mono)", fontSize: 12, color: "var(--alc-fg-3)" }}>
            10-resource Cloudflare stack · warm creds · cold plan · single run
          </div>
        </div>
        <div style={{
          background: "var(--alc-bg-elev-1)",
          border: "1px solid var(--alc-hairline)",
          borderRadius: 12, padding: 28,
        }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
            {data.map((d, i) => (
              <div key={d.name}>
                <div style={{
                  display: "flex", justifyContent: "space-between",
                  fontFamily: "var(--alc-font-mono)", fontSize: 12,
                  color: "var(--alc-fg-2)", marginBottom: 6,
                }}>
                  <span style={{ fontWeight: i === 0 ? 600 : 400, color: i === 0 ? "var(--alc-accent-deep)" : "var(--alc-fg-2)" }}>
                    {d.name}
                  </span>
                  <span>{d.v}s</span>
                </div>
                <div style={{ height: 10, background: "var(--alc-bg-sunk)", borderRadius: 4, overflow: "hidden" }}>
                  <div style={{
                    height: "100%", width: `${(d.v / max) * 100}%`,
                    background: d.color, borderRadius: 4,
                    transition: "width 600ms var(--alc-ease)",
                  }} />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Section>
  );
}

function IaCExtension() {
  return (
    <Section padding="96px 32px" style={{ background: "var(--alc-bg-nav)" }}>
      <div style={{ textAlign: "center", marginBottom: 48 }}>
        <Eyebrow>extend</Eyebrow>
        <h2 className="alc-h2" style={{ margin: "12px 0 12px" }}>
          A new resource is one file, not a plugin.
        </h2>
        <p style={{ fontSize: 15, color: "var(--alc-fg-3)", maxWidth: 640, margin: "0 auto" }}>
          No Go SDK. No codegen. No schema dance. Write a Resource contract, write a Provider,
          ship it as a package. That's it.
        </p>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 32, alignItems: "start" }}>
        <CodeBlock filename="Stream.ts">
{T.c("// 1. Declare the Resource contract")}{"\n"}
{T.k("export interface")} {T.t("Stream")} {T.k("extends")} {T.v("Resource")}{"<"}{"\n"}
{"  "}{T.s('"AWS.Kinesis.Stream"')},{"\n"}
{"  "}{T.t("StreamProps")},{"\n"}
{"  "}{"{ streamArn: "}{T.t("string")}{", streamStatus: "}{T.t("Status")}{" }"}{"\n"}
{">"}{" {}"};{"\n"}
{"\n"}
{T.k("export const")} {T.v("Stream")} = {T.v("Resource")}{"<"}{T.t("Stream")}{">"}({"\n"}
{"  "}{T.s('"AWS.Kinesis.Stream"')}{"\n"}
);
        </CodeBlock>
        <CodeBlock filename="StreamProvider.ts">
{T.c("// 2. Implement lifecycle — create / update / delete")}{"\n"}
{T.k("export const")} {T.v("StreamProvider")} = () =>{"\n"}
{"  "}{T.v("Stream")}.provider.{T.f("effect")}({T.v("Effect")}.{T.f("gen")}({T.k("function")}* () {"{"}{"\n"}
{"    "}{T.k("const")} region = {T.k("yield")}* {T.v("Region")};{"\n"}
{"\n"}
{"    "}{T.k("return")} {"{"}{"\n"}
{"      "}create: {T.v("Effect")}.{T.f("fn")}({T.k("function")}* ({"{"} news {"}"}) {"{"}{"\n"}
{"        "}{T.k("yield")}* kinesis.{T.f("createStream")}(...);{"\n"}
{"        "}{T.k("return")} {"{ streamArn, streamStatus: "}{T.s('"ACTIVE"')}{" };"}{"\n"}
{"      "}{"}),"}{"\n"}
{"      "}update: ..., delete: ...,{"\n"}
{"    "}{"};"}{"\n"}
{"  "}{"}));"}{"\n"}
        </CodeBlock>
      </div>
      <div style={{
        marginTop: 32, textAlign: "center",
        fontFamily: "var(--alc-font-hand)", fontSize: 30,
        color: "var(--alc-accent-deep)", transform: "rotate(-1deg)",
      }}>
        ↑ your whole "provider". no codegen, no plugin protocol.
      </div>
    </Section>
  );
}

function IaCEmbeddable() {
  return (
    <Section padding="96px 32px">
      <div style={{ display: "grid", gridTemplateColumns: "1.3fr 1fr", gap: 56, alignItems: "center" }}>
        <Terminal title="~/my-cli" content={`[d]// shipping alchemy inside your own tool[/d]
[d]$[/d] npx my-platform init my-service

[g]✓[/g] [b]clone template[/b]
[g]✓[/g] [b]alchemy.plan[/b] [d](dry-run)[/d]
[s2][d]+ Bucket (Cloudflare.R2Bucket)[/d]
[s2][d]+ Worker (Cloudflare.Worker)[/d]
[s2][d]+ KV    (Cloudflare.KV)[/d]
[g]✓[/g] [b]alchemy.deploy[/b]
[s2][g]→ https://my-service.acme.dev[/g]

[d]embedded in: @acme/cli · 2.4 MB bundle[/d]`} />
        <div>
          <Eyebrow>embeddable</Eyebrow>
          <h2 className="alc-h2" style={{ margin: "12px 0 16px" }}>
            Ship it inside your own CLI.
          </h2>
          <p style={{ fontSize: 16, lineHeight: 1.7, color: "var(--alc-fg-2)", margin: "0 0 14px" }}>
            alchemy is a library first, a CLI second. Import
            <code style={{ fontFamily: "var(--alc-font-mono)", fontSize: 14, padding: "0 4px" }}>
              alchemy/Stack
            </code>
            , call <code style={{ fontFamily: "var(--alc-font-mono)", fontSize: 14, padding: "0 4px" }}>.deploy()</code>.
          </p>
          <p style={{ fontSize: 16, lineHeight: 1.7, color: "var(--alc-fg-2)", margin: "0 0 14px" }}>
            Platform teams use this to ship opinionated deployment flows.
            App teams use this to run scripted migrations. No Go binary to
            bundle. No backend service to depend on.
          </p>
        </div>
      </div>
    </Section>
  );
}

function IaCFeatureRow() {
  const items = [
    { h: "Plan, deploy, destroy", b: "Preview with plan, apply with deploy, tear down with destroy. Stages isolate dev and prod." },
    { h: "Typed outputs", b: "Output<T> flows through the graph with full inference. No JSON-pointer interpolation strings." },
    { h: "Parallel by default", b: "Resources are Effects. Independent ones plan and deploy concurrently. No -parallelism flag." },
    { h: "Predictable state", b: "State is a typed record. Back it with a file, S3, or a Cloudflare Durable Object. Your choice." },
    { h: "Real test doubles", b: "Provide a mock Layer for a provider. Unit-test your Stack without hitting a cloud." },
    { h: "Bring your own providers", b: "Fork a provider file. Publish as a package. No plugin registry, no protocol version." },
  ];
  return (
    <Section padding="96px 32px" style={{ background: "var(--alc-bg-elev-1)", borderTop: "1px solid var(--alc-hairline)" }}>
      <div style={{ textAlign: "center", marginBottom: 48 }}>
        <Eyebrow>the rest of the package</Eyebrow>
        <h2 className="alc-h2" style={{ margin: "12px 0" }}>Everything you expect from an IaC engine.</h2>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 20 }}>
        {items.map((it, i) => (
          <div key={i} style={{
            background: "var(--alc-bg)",
            border: "1px solid var(--alc-hairline)",
            borderRadius: 10, padding: 22,
            display: "flex", flexDirection: "column", gap: 10,
          }}>
            <h4 style={{
              fontFamily: "var(--alc-font-sans)", fontSize: 16, fontWeight: 600,
              color: "var(--alc-fg-1)", margin: 0, letterSpacing: "-0.01em",
            }}>{it.h}</h4>
            <p style={{ fontSize: 13.5, lineHeight: 1.6, color: "var(--alc-fg-3)", margin: 0 }}>{it.b}</p>
          </div>
        ))}
      </div>
    </Section>
  );
}

function IaCCTA() {
  return (
    <Section padding="96px 32px 40px">
      <div style={{ textAlign: "center" }}>
        <h2 className="alc-h2" style={{ margin: "0 0 16px" }}>
          Migrate one stack. See for yourself.
        </h2>
        <p style={{ fontSize: 16, color: "var(--alc-fg-2)", maxWidth: 560, margin: "0 auto 28px" }}>
          Tutorial walks you from zero to a deployed Cloudflare Worker with bindings,
          integration tests, local dev, and CI/CD — in under 30 minutes.
        </p>
        <div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
          <Button variant="primary" icon="arrow">Start the tutorial</Button>
          <Button variant="secondary">Migration guide · Pulumi</Button>
          <Button variant="ghost">Migration guide · Terraform</Button>
        </div>
      </div>
    </Section>
  );
}

Object.assign(window, {
  IaCHero, IaCComparisonTable, IaCSpeedChart, IaCExtension,
  IaCEmbeddable, IaCFeatureRow, IaCCTA,
});
