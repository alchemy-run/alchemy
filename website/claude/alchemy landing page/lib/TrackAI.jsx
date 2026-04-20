function AIHero() {
  return (
    <Section padding="72px 32px 48px">
      <div style={{ textAlign: "center", marginBottom: 24 }}><AlphaBadge /></div>
      <div style={{ display: "grid", gridTemplateColumns: "1.1fr 1fr", gap: 56, alignItems: "center" }}>
        <div>
          <Eyebrow>for ai-native development</Eyebrow>
          <h1 style={{
            fontFamily: "var(--alc-font-serif)", fontWeight: 500,
            fontSize: 72, lineHeight: 1.02, letterSpacing: "-0.02em",
            margin: "18px 0 20px", color: "var(--alc-fg-1)",
          }}>
            The shape your<br/><span style={{ color: "var(--alc-accent-deep)", fontStyle: "italic" }}>agent can ship</span>.
          </h1>
          <p style={{ fontSize: 19, lineHeight: 1.55, color: "var(--alc-fg-2)", maxWidth: 520, margin: "0 0 32px" }}>
            alchemy gives agents a narrow, type-safe surface — one TypeScript file that covers design, deploy, observe, and alarm. If it compiles, it ships.
          </p>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <Button variant="primary" icon="arrow">Read the agent guide</Button>
            <Button variant="secondary">Prompt library</Button>
            <Button variant="ghost" icon="github">GitHub</Button>
          </div>
        </div>
        <div style={{ background: "var(--alc-bg-code)", border: "1px solid var(--alc-hairline)", borderRadius: 12, overflow: "hidden", boxShadow: "var(--alc-shadow-lg)" }}>
          <div style={{ padding: "10px 14px", borderBottom: "1px solid rgba(232,220,192,0.08)", fontFamily: "var(--alc-font-mono)", fontSize: 11, color: "var(--alc-code-comment)", display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--alc-accent-bright)" }} />
            agent · alchemy.run.ts
          </div>
          <pre style={{ margin: 0, padding: "16px 18px", fontFamily: "var(--alc-font-mono)", fontSize: 12.5, lineHeight: 1.75, color: "var(--alc-code-var)" }}>
{T.c("// prompt: add image uploads to the app")}{"\n\n"}
{T.k("const")} uploads = {T.k("yield")}* {T.v("Cloudflare")}.{T.f("R2Bucket")}({T.s('"uploads"')});{"\n"}
{T.k("const")} put = {T.k("yield")}* {T.v("R2")}.{T.v("Put")}.{T.f("bind")}(uploads);{"\n\n"}
{T.v("yield")}* {T.v("Http")}.{T.f("route")}({T.s('"POST"')}, {T.s('"/upload"')},{"\n"}
{"  "}{T.v("Effect")}.{T.f("fn")}({T.k("function")}* (req) {"{"}{"\n"}
{"    "}{T.k("const")} id = crypto.{T.f("randomUUID")}();{"\n"}
{"    "}{T.k("yield")}* {T.f("put")}({"{"} key: id, body: req.body {"}"});{"\n"}
{"    "}{T.k("return")} {"{"} id {"}"};{"\n"}
{"  "}{"}),"}{"\n"}
{");"}
          </pre>
          <div style={{ padding: "10px 14px", borderTop: "1px solid rgba(232,220,192,0.08)", fontFamily: "var(--alc-font-mono)", fontSize: 11, display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ color: "var(--alc-success)" }}>✓ typecheck</span>
            <span style={{ color: "var(--alc-success)" }}>✓ plan</span>
            <span style={{ color: "var(--alc-success)" }}>✓ preview deployed</span>
          </div>
        </div>
      </div>
    </Section>
  );
}

function AILoop() {
  const steps = [
    { k: "design", b: "Agent sketches a Stack. Types catch missing bindings, wrong regions, impossible shapes — before you run anything." },
    { k: "build",  b: "Schema-typed HttpApi and Rpc. The handler the agent writes fits the contract — or TypeScript rejects it." },
    { k: "test",   b: "Provide a mock Layer and run the Stack in-memory. Agent can loop on failing tests with fast feedback." },
    { k: "deploy", b: "alchemy deploy --stage preview per PR. Ephemeral stages, clean destroy. Safe to iterate." },
    { k: "observe",b: "OTEL traces flow back. Agent reads real latency, errors, bindings used. Informs the next patch." },
    { k: "alarm",  b: "Define alarms as Resources. Bind a Lambda to an alarm, ship an auto-remediation, move on." },
  ];
  return (
    <Section padding="96px 32px" style={{ background: "var(--alc-bg-elev-1)", borderTop: "1px solid var(--alc-hairline)", borderBottom: "1px solid var(--alc-hairline)" }}>
      <div style={{ textAlign: "center", marginBottom: 56 }}>
        <Eyebrow>one representation · end to end</Eyebrow>
        <h2 className="alc-h2" style={{ margin: "12px 0 12px" }}>The whole lifecycle, as code the agent can read.</h2>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 14 }}>
        {steps.map((s, i) => (
          <div key={s.k} style={{ background: "var(--alc-bg)", border: "1px solid var(--alc-hairline)", borderRadius: 10, padding: 18, display: "flex", flexDirection: "column", gap: 10, position: "relative" }}>
            <div style={{ fontFamily: "var(--alc-font-mono)", fontSize: 11, color: "var(--alc-fg-4)", letterSpacing: "0.08em" }}>0{i + 1}</div>
            <div style={{ fontFamily: "var(--alc-font-sans)", fontSize: 15, fontWeight: 600, color: "var(--alc-fg-1)" }}>{s.k}</div>
            <p style={{ fontSize: 12.5, lineHeight: 1.55, color: "var(--alc-fg-3)", margin: 0 }}>{s.b}</p>
            {i < steps.length - 1 && <span style={{ position: "absolute", top: 24, right: -10, color: "var(--alc-walnut-400)", fontSize: 14 }}>→</span>}
          </div>
        ))}
      </div>
    </Section>
  );
}

const pillBad = { display: "inline-block", fontFamily: "var(--alc-font-mono)", fontSize: 11, padding: "4px 10px", borderRadius: 999, background: "color-mix(in srgb, var(--alc-danger) 12%, transparent)", color: "var(--alc-danger)", marginBottom: 10 };
const pillOk = { display: "inline-block", fontFamily: "var(--alc-font-mono)", fontSize: 11, padding: "4px 10px", borderRadius: 999, background: "var(--alc-accent-12)", color: "var(--alc-accent-deep)", marginBottom: 10 };

function AIWhyTyped() {
  return (
    <Section padding="96px 32px">
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1.2fr", gap: 56, alignItems: "start" }}>
        <div style={{ position: "sticky", top: 100 }}>
          <Eyebrow>typed primitives = fewer hallucinations</Eyebrow>
          <h2 className="alc-h2" style={{ margin: "12px 0 16px" }}>Make the type system the guardrail.</h2>
          <p style={{ fontSize: 16, lineHeight: 1.7, color: "var(--alc-fg-2)" }}>
            Agents write confident, wrong code. Most IaC tools accept that wrong code and fail 45 seconds into a deploy. alchemy rejects it in the editor — at the exact token that's wrong.
          </p>
          <p style={{ fontSize: 16, lineHeight: 1.7, color: "var(--alc-fg-2)" }}>
            Narrow surface area. Sharp types. Fast feedback.
          </p>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          <div>
            <div style={pillBad}>✗ without alchemy</div>
            <CodeBlock filename="stack.yaml" compact>
{T.c("# agent emits plausible YAML")}{"\n"}
Resources:{"\n"}
{"  "}MyBucket:{"\n"}
{"    "}Type: AWS::S3::Bucket{"\n"}
{"    "}Properties:{"\n"}
{"      "}BucketName: {T.err("!Ref DataBucket")}   {T.c("# hallucinated ref")}{"\n"}
{"      "}VersioningConfig: Enabled   {T.c("# wrong shape")}{"\n"}
            </CodeBlock>
            <div style={{ marginTop: 10, fontSize: 13, color: "var(--alc-fg-3)" }}>fails 45s into deploy. agent loops on a parse error, not a typed one.</div>
          </div>
          <div>
            <div style={pillOk}>✓ with alchemy</div>
            <CodeBlock filename="stack.ts" compact>
{T.k("const")} bucket = {T.k("yield")}* {T.v("AWS")}.{T.v("S3")}.{T.f("Bucket")}({T.s('"Data"')}, {"{"}{"\n"}
{"  "}bucketName: {T.err('"DataBucket"')},         {T.c("// type error — Output<string>")}{"\n"}
{"  "}versioning: {T.err('"enabled"')},            {T.c("// expected VersioningConfig")}{"\n"}
{"}"});
            </CodeBlock>
            <div style={{ marginTop: 10, fontSize: 13, color: "var(--alc-fg-3)" }}>red squigglies instantly. agent reads the error, patches the token, moves on.</div>
          </div>
        </div>
      </div>
    </Section>
  );
}

function AIPromptFlow() {
  return (
    <Section padding="96px 32px" style={{ background: "var(--alc-bg-nav)" }}>
      <div style={{ textAlign: "center", marginBottom: 48 }}>
        <Eyebrow>prompt → deploy</Eyebrow>
        <h2 className="alc-h2" style={{ margin: "12px 0 12px" }}>Inside the agent loop.</h2>
      </div>
      <div style={{ maxWidth: 900, margin: "0 auto" }}>
        <Terminal title="claude · my-app" content={`[c]>[/c] [b]Add image uploads. Store in R2. Return the URL.[/b]

[d]thinking...[/d]

[d]$[/d] alchemy plan
[w]~[/w] [b]uploads[/b]  [d](Cloudflare.R2Bucket)[/d]  [g]+ create[/g]
[w]~[/w] [b]app[/b]      [d](Cloudflare.Worker)[/d]    [y]update bindings[/y] [c]+ R2.Put[/c]

[d]typecheck...[/d]  [g]✓[/g] 0 errors  [d](118ms)[/d]
[d]tests...[/d]      [g]✓[/g] 3 passed  [d](412ms)[/d]

[d]$[/d] alchemy deploy --stage preview
[g]✓[/g] deployed in [b]3.4s[/b]
[s2][g]→ https://pr-214.my-app.workers.dev[/g]

[c]<[/c] [b]done. preview here:[/b] [u]https://pr-214.my-app.workers.dev[/u]
[s2][d]runtime trace[/d] [c]p50=41ms · p99=88ms[/c]
[s2][d]cost estimate[/d] [c]~ $0.02 / day[/c]`} />
      </div>
    </Section>
  );
}

function AIIntegrations() {
  const tools = [
    { name: "Claude Code", desc: "MCP server exposes alchemy plan/deploy/destroy to Claude." },
    { name: "Cursor", desc: ".cursorrules and a prompt library tuned to alchemy's primitives." },
    { name: "Codex", desc: "Structured function-calling schemas for every resource." },
    { name: "Your agent", desc: "It's just TypeScript. Spawn a bun process, read stdout. Done." },
  ];
  return (
    <Section padding="96px 32px">
      <div style={{ textAlign: "center", marginBottom: 48 }}>
        <Eyebrow>integrations</Eyebrow>
        <h2 className="alc-h2" style={{ margin: "12px 0 12px" }}>Bring your agent.</h2>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16 }}>
        {tools.map(t => (
          <div key={t.name} style={{ background: "var(--alc-bg-elev-1)", border: "1px solid var(--alc-hairline)", borderRadius: 10, padding: 22, display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ fontFamily: "var(--alc-font-sans)", fontSize: 16, fontWeight: 600, color: "var(--alc-fg-1)" }}>{t.name}</div>
            <p style={{ fontSize: 13, lineHeight: 1.55, color: "var(--alc-fg-3)", margin: 0 }}>{t.desc}</p>
          </div>
        ))}
      </div>
    </Section>
  );
}

function AIComparison() {
  const rows = [
    ["surface area", "one Stack file", "YAML + Go provider + templates + aws-cli"],
    ["error feedback", "TS diagnostic on the offending token", "deploy-time CFN message, 45s later"],
    ["plan as a value", "Effect, typed", "CLI output text"],
    ["test doubles", "provide a Layer", "mock the cloud in shell"],
    ["ephemeral envs", "stage per branch, destroy on merge", "manual cleanup"],
    ["observability feedback", "OTEL traces back into context", "logs, maybe"],
    ["patchability", "one file, one import", "scattered across tools"],
  ];
  return (
    <Section padding="96px 32px" style={{ background: "var(--alc-bg-elev-1)", borderTop: "1px solid var(--alc-hairline)" }}>
      <div style={{ textAlign: "center", marginBottom: 40 }}>
        <Eyebrow>for the loop</Eyebrow>
        <h2 className="alc-h2" style={{ margin: "12px 0 12px" }}>What agents get from alchemy.</h2>
      </div>
      <div style={{ background: "var(--alc-bg)", border: "1px solid var(--alc-hairline)", borderRadius: 12, overflow: "hidden" }}>
        <div style={{ display: "grid", gridTemplateColumns: "1.3fr 1.2fr 1.5fr", padding: "14px 20px", background: "var(--alc-bg-sunk)", borderBottom: "1px solid var(--alc-hairline)", fontFamily: "var(--alc-font-mono)", fontSize: 11, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--alc-fg-4)" }}>
          <span></span>
          <span style={{ color: "var(--alc-accent-deep)" }}>alchemy</span>
          <span>legacy IaC</span>
        </div>
        {rows.map((r, i) => (
          <div key={i} style={{ display: "grid", gridTemplateColumns: "1.3fr 1.2fr 1.5fr", padding: "14px 20px", gap: 12, borderBottom: i === rows.length - 1 ? "none" : "1px solid var(--alc-hairline)", fontSize: 14, alignItems: "center" }}>
            <span style={{ color: "var(--alc-fg-1)", fontWeight: 500, fontFamily: "var(--alc-font-mono)", fontSize: 12 }}>{r[0]}</span>
            <span style={{ color: "var(--alc-fg-1)", fontWeight: 500 }}>{r[1]}</span>
            <span style={{ color: "var(--alc-fg-3)" }}>{r[2]}</span>
          </div>
        ))}
      </div>
    </Section>
  );
}

function AICTA() {
  return (
    <Section padding="96px 32px 40px">
      <div style={{ textAlign: "center" }}>
        <h2 className="alc-h2" style={{ margin: "0 0 16px" }}>Give your agent a scalable foundation.</h2>
        <div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
          <Button variant="primary" icon="arrow">Agent guide</Button>
          <Button variant="secondary">MCP for Claude Code</Button>
          <Button variant="ghost">Prompt library</Button>
        </div>
      </div>
    </Section>
  );
}

Object.assign(window, { AIHero, AILoop, AIWhyTyped, AIPromptFlow, AIIntegrations, AIComparison, AICTA });
