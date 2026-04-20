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
      // simple-icons removed AWS in v15 (trademark review) and devicon only
      // ships wordmark variants — which would duplicate the "AWS" heading.
      // Self-hosted square smile-glyph keeps it visually consistent with the
      // single Cloudflare cloud glyph.
      logos: [{ slug: "aws", src: "/landing/logos/aws-smile.svg" }],
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
{"    "}{T.k("const")} kv     = {T.k("yield")}* {T.v("KV")};{"\n"}
{"    "}{T.k("const")} api    = {T.k("yield")}* {T.v("Api")};{"\n"}
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

// Tabs for Cloudflare feature breadth (all grounded in the real example)
function CloudFeatureTabs() {
  const [tab, setTab] = useState3("do");
  const tabs = [
    { k: "do",   label: "Durable Objects" },
    { k: "wf",   label: "Workflows" },
    { k: "ctr",  label: "Containers" },
  ];
  const code = {
    do: <>
{T.c("// src/Room.ts — a Durable Object, typed WebSocket + hibernation")}{"\n"}
{T.k("export default")} {T.k("class")} {T.t("Room")} {T.k("extends")} {T.v("Cloudflare")}.{T.f("DurableObjectNamespace")}{"<"}{T.t("Room")}{">()"}({"\n"}
{"  "}{T.s('"Rooms"')},{"\n"}
{"  "}{T.v("Effect")}.{T.f("gen")}({T.k("function")}* () {"{"}{"\n"}
{"    "}{T.k("const")} state = {T.k("yield")}* {T.v("Cloudflare")}.{T.v("DurableObjectState")};{"\n\n"}
{"    "}{T.k("return")} {"{"}{"\n"}
{"      "}fetch: {T.v("Cloudflare")}.{T.f("upgrade")}(),{"\n"}
{"      "}webSocketMessage: {T.c("/* broadcast to peers */")},{"\n"}
{"    "}{"};"}{"\n"}
{"  "}{"}),"}{"\n"}
{") {"}{"}"}
    </>,
    wf: <>
{T.c("// start a Workflow from inside a Worker — typed input, typed handle")}{"\n"}
{T.k("const")} notifier = {T.k("yield")}* {T.v("NotifyWorkflow")};{"\n\n"}
{T.k("const")} instance = {T.k("yield")}* notifier.{T.f("create")}({"{"}{"\n"}
{"  "}roomId: {T.s('"general"')},{"\n"}
{"  "}message: {T.s('"hello from workflow"')},{"\n"}
{"}"});{"\n\n"}
{T.k("const")} status = {T.k("yield")}* ({T.k("yield")}* notifier.{T.f("get")}(instance.id)).{T.f("status")}();{"\n"}
{T.k("return")} {T.k("yield")}* {T.v("HttpServerResponse")}.{T.f("json")}(status);
    </>,
    ctr: <>
{T.c("// bind a Container, start it from a DO, speak HTTP to it")}{"\n"}
{T.k("const")} sandbox = {T.k("yield")}* {T.v("Cloudflare")}.{T.v("Container")}.{T.f("bind")}({T.v("Sandbox")});{"\n"}
{T.k("const")} container = {T.k("yield")}* {T.v("Cloudflare")}.{T.f("start")}(sandbox);{"\n\n"}
{T.k("const")} {"{ fetch }"} = {T.k("yield")}* container.{T.f("getTcpPort")}({T.n("3000")});{"\n"}
{T.k("const")} response = {T.k("yield")}* fetch({"\n"}
{"  "}{T.v("HttpClientRequest")}.{T.f("post")}({T.s('"http://container/increment"')}),{"\n"}
{");"}{"\n"}
{T.k("return")} {T.k("yield")}* response.text;
    </>,
  };
  const filenames = { do: "src/Room.ts", wf: "src/Api.ts", ctr: "src/Agent.ts" };
  return (
    <Section padding="96px 32px">
      <div style={{ textAlign: "center", marginBottom: 36 }}>
        <Eyebrow>everything cloudflare ships</Eyebrow>
        <h2 className="alc-h2" style={{ margin: "12px 0 12px" }}>Typed all the way down.</h2>
        <p style={{ fontSize: 16, lineHeight: 1.65, color: "var(--alc-fg-2)", maxWidth: 640, margin: "12px auto 0" }}>
          Durable Objects, Workflows, Containers, R2, KV, D1 — all first-class. Write the runtime as Effect; alchemy handles the deploy wiring.
        </p>
      </div>
      <div style={{ display: "flex", justifyContent: "center", gap: 4, marginBottom: 20, flexWrap: "wrap" }}>
        {tabs.map(t => (
          <button key={t.k} onClick={() => setTab(t.k)} style={{
            border: "1px solid var(--alc-hairline-2)",
            background: tab === t.k ? "var(--alc-bg-code)" : "var(--alc-bg-elev-1)",
            color: tab === t.k ? "var(--alc-fg-invert)" : "var(--alc-fg-2)",
            fontFamily: "var(--alc-font-mono)", fontSize: 12.5,
            padding: "8px 16px", borderRadius: 8, cursor: "pointer",
          }}>{t.label}</button>
        ))}
      </div>
      <div style={{ maxWidth: 900, margin: "0 auto" }}>
        <CodeBlock filename={filenames[tab]}>{code[tab]}</CodeBlock>
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
