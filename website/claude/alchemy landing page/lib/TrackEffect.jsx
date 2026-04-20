// Track 1: Effect community — the "Effects are everything" angle.
// Sketch-forward, hero uses triple diagram, code examples lean on yield*/Layer/Context.

function EffectHero() {
  return (
    <Section padding="72px 32px 48px">
      <div style={{ textAlign: "center", marginBottom: 28 }}>
        <AlphaBadge />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1.1fr 1fr", gap: 56, alignItems: "center" }}>
        <div>
          <Eyebrow>for the effect community</Eyebrow>
          <h1 style={{
            fontFamily: "var(--alc-font-serif)", fontWeight: 500,
            fontSize: 72, lineHeight: 1.02, letterSpacing: "-0.02em",
            margin: "18px 0 0", color: "var(--alc-fg-1)",
          }}>
            Your cloud is<br/>
            <span style={{ color: "var(--alc-accent-deep)", fontStyle: "italic" }}>one Effect</span>.
          </h1>
          <p style={{
            fontSize: 19, lineHeight: 1.55, color: "var(--alc-fg-2)",
            maxWidth: 520, margin: "22px 0 32px",
          }}>
            Infrastructure, runtime, and wiring collapse into one <code style={inlineCode}>Effect</code>.
            Resources are declared with <code style={inlineCode}>yield*</code>.
            Bindings are Layers. Providers are Context. The compiler proves it deploys.
          </p>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <Button variant="primary" icon="arrow">Read the tutorial</Button>
            <Button variant="secondary">See examples</Button>
            <Button variant="ghost" icon="github">GitHub</Button>
          </div>
          <div style={{
            marginTop: 28, display: "flex", gap: 28, alignItems: "center",
            fontFamily: "var(--alc-font-mono)", fontSize: 12, color: "var(--alc-fg-3)",
          }}>
            <span>works with <b style={{ color: "var(--alc-fg-1)" }}>effect ≥ 3.14</b></span>
            <span style={{ color: "var(--alc-fg-4)" }}>·</span>
            <span>runs on <b style={{ color: "var(--alc-fg-1)" }}>Node 20+</b> / Bun / Deno</span>
          </div>
        </div>

        {/* Sketch-style hero: the Function → Binding → Resource triple */}
        <div style={{ position: "relative" }}>
          <div style={{
            background: "var(--alc-bg-elev-1)",
            border: "1px solid var(--alc-hairline)",
            borderRadius: 14, padding: 32,
            boxShadow: "var(--alc-shadow-sm)",
          }}>
            <img src="assets/diagram-triple.png" alt="Function to Binding to Resource"
                 style={{ width: "100%", display: "block", mixBlendMode: "multiply" }} />
            <SketchLabel style={{ position: "absolute", bottom: 18, right: 24, fontSize: 24, transform: "rotate(-3deg)" }}>
              one program. ↷
            </SketchLabel>
          </div>
        </div>
      </div>
    </Section>
  );
}

const inlineCode = {
  fontFamily: "var(--alc-font-mono)", fontSize: "0.85em",
  padding: "0.12em 0.4em", borderRadius: 4,
  background: "var(--alc-bg-sunk)", border: "1px solid var(--alc-hairline)",
  color: "var(--alc-fg-1)",
};

function EffectPrimitivesMap() {
  const rows = [
    { effect: "Effect.Effect<A, E, R>", alchemy: "Stack / Resource body", what: "The unit of work. Your entire program is one of these." },
    { effect: "Context.Service<Svc, …>", alchemy: "Binding.Service", what: "A capability handle — S3.GetObject, Kinesis.PutRecord." },
    { effect: "Layer<ROut, E, RIn>", alchemy: "Provider / PolicyLive", what: "Everything wires up as Layers. Providers, policies, runtime services." },
    { effect: "yield* resource", alchemy: "Declare a Resource", what: "Reading a Resource from Context is how you declare it." },
    { effect: "Effect.gen", alchemy: "Stack composition", what: "Imperative-style Effect composition. Familiar from day one." },
    { effect: "Stream<A, E, R>", alchemy: "Event sources", what: "S3 notifications, SQS queues, Kinesis streams — all Streams." },
    { effect: "Schema.Struct", alchemy: "HttpApi / Rpc payloads", what: "Same Schema you already use for validation." },
    { effect: "Config.string", alchemy: "Stage configuration", what: "AWS region, account — just Config." },
  ];
  return (
    <Section style={{ background: "var(--alc-bg-elev-1)", borderTop: "1px solid var(--alc-hairline)", borderBottom: "1px solid var(--alc-hairline)" }}>
      <div style={{ textAlign: "center", marginBottom: 48 }}>
        <Eyebrow>the primitive map</Eyebrow>
        <h2 className="alc-h2" style={{ margin: "12px 0 12px" }}>
          If you know Effect, you know alchemy.
        </h2>
        <p style={{ fontSize: 16, color: "var(--alc-fg-3)", maxWidth: 620, margin: "0 auto" }}>
          Every alchemy concept is a thin, honest shape on top of an Effect primitive you already use.
        </p>
      </div>

      <div style={{
        background: "var(--alc-bg)",
        border: "1px solid var(--alc-hairline)",
        borderRadius: 12,
        overflow: "hidden",
      }}>
        <div style={{
          display: "grid", gridTemplateColumns: "1.1fr 1fr 1.4fr",
          padding: "14px 20px",
          borderBottom: "1px solid var(--alc-hairline)",
          background: "var(--alc-bg-sunk)",
          fontFamily: "var(--alc-font-mono)", fontSize: 11,
          letterSpacing: "0.12em", textTransform: "uppercase",
          color: "var(--alc-fg-4)",
        }}>
          <span>Effect</span>
          <span>alchemy</span>
          <span>what it does</span>
        </div>
        {rows.map((r, i) => (
          <div key={i} style={{
            display: "grid", gridTemplateColumns: "1.1fr 1fr 1.4fr",
            padding: "14px 20px", gap: 16,
            borderBottom: i === rows.length - 1 ? "none" : "1px solid var(--alc-hairline)",
            alignItems: "center",
          }}>
            <code style={{ fontFamily: "var(--alc-font-mono)", fontSize: 12.5, color: "var(--alc-accent-deep)" }}>
              {r.effect}
            </code>
            <code style={{ fontFamily: "var(--alc-font-mono)", fontSize: 12.5, color: "var(--alc-terracotta-deep)" }}>
              {r.alchemy}
            </code>
            <span style={{ fontSize: 13.5, color: "var(--alc-fg-2)", lineHeight: 1.5 }}>
              {r.what}
            </span>
          </div>
        ))}
      </div>
    </Section>
  );
}

function EffectCodeShowcase() {
  return (
    <Section padding="96px 32px">
      <div style={{ textAlign: "center", marginBottom: 56 }}>
        <Eyebrow>resources · bindings · services</Eyebrow>
        <h2 className="alc-h2" style={{ margin: "12px 0 12px" }}>
          Three shapes. That's the whole model.
        </h2>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 64 }}>
        {/* Resource */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1.3fr", gap: 48, alignItems: "start" }}>
          <div>
            <div style={stepNum}>01</div>
            <h3 className="alc-h3" style={{ margin: "12px 0 10px" }}>Resources are Effects.</h3>
            <p style={prose}>
              A Resource is an Effect that produces typed Output Attributes. You declare
              it with <code style={inlineCode}>yield*</code>. Outputs flow into other
              Resources. The engine resolves the dependency graph.
            </p>
            <p style={prose}>
              No HCL, no JSON, no YAML. No separate "stack file" language. Your
              resource graph is a <code style={inlineCode}>Effect.gen</code>.
            </p>
          </div>
          <CodeBlock filename="stack.ts">
{T.k("export default")} {T.v("Effect")}.{T.f("gen")}({T.k("function")}* () {"{"}{"\n"}
{"  "}{T.k("const")} bucket = {T.k("yield")}* {T.v("AWS")}.{T.v("S3")}.{T.f("Bucket")}({T.s('"Data"')}, {"{"}{"\n"}
{"    "}forceDestroy: {T.k("true")},{"\n"}
{"  "}{"});"}{"\n"}
{"\n"}
{"  "}{T.k("const")} table = {T.k("yield")}* {T.v("AWS")}.{T.v("DynamoDB")}.{T.f("Table")}({T.s('"Users"')}, {"{"}{"\n"}
{"    "}tableName: {T.s('"users"')},{"\n"}
{"    "}partitionKey: {"{ name: "}{T.s('"pk"')}{", type: "}{T.s('"S"')}{" },"}{"\n"}
{"  "}{"});"}{"\n"}
{"\n"}
{"  "}{T.k("return")} {"{"}{"\n"}
{"    "}bucketArn: bucket.bucketArn,  {T.c("// Output<string>")}{"\n"}
{"    "}tableArn: table.tableArn,{"\n"}
{"  "}{"};"}{"\n"}
{"}"}).pipe({T.v("Stack")}.{T.f("make")}({T.s('"MyStack"')}));
          </CodeBlock>
        </div>

        {/* Bindings */}
        <div style={{ display: "grid", gridTemplateColumns: "1.3fr 1fr", gap: 48, alignItems: "start" }}>
          <CodeBlock filename="function.ts">
{T.k("export default")} {T.v("Effect")}.{T.f("gen")}({T.k("function")}* () {"{"}{"\n"}
{"  "}{T.k("const")} bucket = {T.k("yield")}* {T.v("S3")}.{T.f("Bucket")}({T.s('"DataBucket"')});{"\n"}
{"\n"}
{"  "}{T.c("// capabilities — runtime + IAM, both provable")}{"\n"}
{"  "}{T.k("const")} getObject = {T.k("yield")}* {T.v("S3")}.{T.v("GetObject")}.{T.f("bind")}(bucket);{"\n"}
{"  "}{T.k("const")} putObject = {T.k("yield")}* {T.v("S3")}.{T.v("PutObject")}.{T.f("bind")}(bucket);{"\n"}
{"\n"}
{"  "}{T.k("yield")}* {T.v("Http")}.{T.f("serve")}(myHttpApp);{"\n"}
{"\n"}
{"  "}{T.k("return")} {"{ main: "}{T.v("import")}.meta.filename, url: {T.k("true")} {"}"} {T.k("as const")};{"\n"}
{"}"}).pipe({"\n"}
{"  "}{T.v("Effect")}.{T.f("provide")}({T.v("Layer")}.{T.f("mergeAll")}({"\n"}
{"    "}{T.v("Http")}.lambdaHttpServer,{"\n"}
{"    "}{T.v("S3")}.GetObjectLive,{"\n"}
{"    "}{T.v("S3")}.PutObjectLive,{"\n"}
{"  "})),{"\n"}
{"  "}{T.v("Lambda")}.{T.f("Function")}({T.s('"ApiFunction"')}),{"\n"}
);
          </CodeBlock>
          <div>
            <div style={stepNum}>02</div>
            <h3 className="alc-h3" style={{ margin: "12px 0 10px" }}>Bindings are two Layers.</h3>
            <p style={prose}>
              <b style={{ color: "var(--alc-fg-1)" }}>Binding.Service</b> is the runtime SDK call —
              bundled into your Lambda. <b style={{ color: "var(--alc-fg-1)" }}>Binding.Policy</b> is
              the deploy-time IAM attachment — runs only during <code style={inlineCode}>deploy</code>.
            </p>
            <p style={prose}>
              The Lambda bundle only ships the code it needs. IAM policies resolve at
              deploy time. Forget a Layer and the compiler catches it.
            </p>
          </div>
        </div>

        {/* Services */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1.3fr", gap: 48, alignItems: "start" }}>
          <div>
            <div style={stepNum}>03</div>
            <h3 className="alc-h3" style={{ margin: "12px 0 10px" }}>Package as Services.</h3>
            <p style={prose}>
              Wrap Resources and their bindings into a <code style={inlineCode}>Context.Service</code>.
              The service owns the bucket, the IAM policy, the SDK calls — and exposes a
              clean domain interface to the rest of your app.
            </p>
            <p style={prose}>
              Swap the implementation in tests by providing a different Layer. The tests
              don't know they're not talking to S3.
            </p>
          </div>
          <CodeBlock filename="JobStorage.ts">
{T.k("export class")} {T.t("JobStorage")} {T.k("extends")} {T.v("Context")}.{T.f("Service")}{"<"}{"\n"}
{"  "}{T.t("JobStorage")},{"\n"}
{"  "}{"{"}{"\n"}
{"    "}bucket: {T.t("S3")}.{T.t("Bucket")},{"\n"}
{"    "}putJob(job: {T.t("Job")}): {T.t("Effect")}.{T.t("Effect")}{"<"}{T.t("Job")}{">"},{"\n"}
{"    "}getJob(id: {T.t("string")}): {T.t("Effect")}.{T.t("Effect")}{"<"}{T.t("Job")} | {T.k("undefined")}{">"},{"\n"}
{"  "}{"}"}{"\n"}
{">"}()({T.s('"JobStorage"')}) {"{}"}{"\n"}
{"\n"}
{T.k("export const")} jobStorage = {T.v("Layer")}.{T.f("effect")}({T.t("JobStorage")},{"\n"}
{"  "}{T.v("Effect")}.{T.f("gen")}({T.k("function")}* () {"{"}{"\n"}
{"    "}{T.k("const")} bucket = {T.k("yield")}* {T.v("S3")}.{T.f("Bucket")}({T.s('"Jobs"')});{"\n"}
{"    "}{T.k("const")} put = {T.k("yield")}* {T.v("S3")}.{T.v("PutObject")}.{T.f("bind")}(bucket);{"\n"}
{"    "}{T.c("// ...")}{"\n"}
{"  "}{"})"}{"\n"}
);
          </CodeBlock>
        </div>
      </div>
    </Section>
  );
}

const stepNum = {
  fontFamily: "var(--alc-font-mono)", fontSize: 12, letterSpacing: "0.12em",
  color: "var(--alc-terracotta-deep)", fontWeight: 600,
};
const prose = {
  fontSize: 15, lineHeight: 1.7, color: "var(--alc-fg-2)",
  margin: "0 0 14px", maxWidth: 460,
};

function EffectObservability() {
  return (
    <Section padding="96px 32px" style={{ background: "var(--alc-bg-nav)" }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 56, alignItems: "center" }}>
        <div>
          <Eyebrow>observability</Eyebrow>
          <h2 className="alc-h2" style={{ margin: "12px 0 16px" }}>
            OTEL, for free.
          </h2>
          <p style={{ fontSize: 16, lineHeight: 1.7, color: "var(--alc-fg-2)", margin: "0 0 14px" }}>
            Effect's native OpenTelemetry data exports directly from your application.
            Trace a request from the HTTP handler, through the JobStorage service, into
            the S3 SDK call, across clouds.
          </p>
          <p style={{ fontSize: 16, lineHeight: 1.7, color: "var(--alc-fg-2)", margin: "0 0 14px" }}>
            No wrapper libraries. No sidecar. Point it at any OTEL-enabled backend.
          </p>
          <div style={{ marginTop: 20, display: "flex", flexWrap: "wrap", gap: 8 }}>
            {["Honeycomb", "Grafana", "Axiom", "Datadog", "Sentry", "Tempo"].map(n => (
              <span key={n} style={providerChip}>{n}</span>
            ))}
          </div>
        </div>
        <Terminal title="traces · job-api" content={`[d]GET /jobs/abc[/d]  [c]trace_id=[/c][y]af2..c3[/y]

  [g]✓[/g] [b]http.request[/b]               [d]2.4ms[/d]
  [s2][g]✓[/g] [b]JobStorage.getJob[/b]        [d]1.9ms[/d]
  [s2][s2][g]✓[/g] [b]S3.GetObject.bind[/b]     [d]1.4ms[/d]
  [s2][s2][s2][g]✓[/g] [b]aws.s3.getObject[/b]   [d]1.1ms[/d]
  [s2][g]✓[/g] [b]json.decode[/b]              [d]0.1ms[/d]

[d]────────────────────────────────────────[/d]
[d]exported →[/d] [c]otel-collector:4317[/c]`} />
      </div>
    </Section>
  );
}

const providerChip = {
  fontFamily: "var(--alc-font-mono)", fontSize: 12,
  padding: "4px 10px", borderRadius: 999,
  background: "var(--alc-bg-elev-1)",
  border: "1px solid var(--alc-hairline-2)",
  color: "var(--alc-fg-2)",
};

function EffectFeatureRow() {
  const items = [
    { h: "Structured errors", b: "Typed error channels flow from SDK calls, through your services, up to the HTTP handler. Every retry, every fallback, explicit." },
    { h: "Declarative retries", b: "Effect.retry with Schedule.exponential gives you backoff across cloud calls, for free, with no custom wrapper code." },
    { h: "Resources as Layers", b: "A DynamoDB store, a queue, a stripe client — each is a Layer with a Context.Service interface. Provide and swap." },
    { h: "Streams for event sources", b: "S3 notifications, SQS messages, Kinesis records — all the same Stream interface. pipe, flatMap, tapSink." },
    { h: "Schema-validated APIs", b: "HttpApi and Rpc are built on Schema. The types you validate on the server are the types your client consumes." },
    { h: "Works with Effect ecosystem", b: "@effect/platform, @effect/schema, @effect/rpc — alchemy is a good citizen, not a walled garden." },
  ];
  return (
    <Section padding="96px 32px">
      <div style={{ textAlign: "center", marginBottom: 48 }}>
        <Eyebrow>what you get</Eyebrow>
        <h2 className="alc-h2" style={{ margin: "12px 0" }}>
          Effect's superpowers, across your cloud.
        </h2>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 24 }}>
        {items.map((it, i) => (
          <div key={i} style={{
            background: "var(--alc-bg-elev-1)",
            border: "1px solid var(--alc-hairline)",
            borderRadius: 10,
            padding: 22,
            display: "flex", flexDirection: "column", gap: 10,
          }}>
            <div style={{ fontFamily: "var(--alc-font-mono)", fontSize: 11, color: "var(--alc-fg-4)", letterSpacing: "0.08em" }}>0{i + 1}</div>
            <h4 style={{
              fontFamily: "var(--alc-font-sans)", fontSize: 17, fontWeight: 600,
              color: "var(--alc-fg-1)", margin: 0, letterSpacing: "-0.01em",
            }}>{it.h}</h4>
            <p style={{ fontSize: 13.5, lineHeight: 1.6, color: "var(--alc-fg-3)", margin: 0 }}>{it.b}</p>
          </div>
        ))}
      </div>
    </Section>
  );
}

function EffectComparison() {
  const rows = [
    ["runtime model", "Effect", "imperative + adapters", "imperative + adapters"],
    ["typed deps", "Effect.Requirements", "config objects", "ad-hoc"],
    ["typed errors", "native", "try / catch", "try / catch"],
    ["retries & schedules", "Effect.retry", "custom", "custom"],
    ["structured concurrency", "Fiber", "—", "—"],
    ["tracing", "OTEL built-in", "custom instrumentation", "custom instrumentation"],
    ["layer composition", "Effect.Layer", "classes + DI libs", "modules"],
    ["test doubles", "provide a Layer", "mocks / fakes", "mocks / fakes"],
  ];
  return (
    <Section padding="96px 32px" style={{ background: "var(--alc-bg-elev-1)", borderTop: "1px solid var(--alc-hairline)" }}>
      <div style={{ textAlign: "center", marginBottom: 40 }}>
        <Eyebrow>why effect</Eyebrow>
        <h2 className="alc-h2" style={{ margin: "12px 0 12px" }}>What every other IaC gives up.</h2>
        <p style={{ fontSize: 15, color: "var(--alc-fg-3)", maxWidth: 620, margin: "0 auto" }}>
          Other tools treat infrastructure and runtime as separate problems. alchemy
          treats them as the same Effect program.
        </p>
      </div>
      <div style={{
        background: "var(--alc-bg)",
        border: "1px solid var(--alc-hairline)",
        borderRadius: 12,
        overflow: "hidden",
      }}>
        <div style={{
          display: "grid", gridTemplateColumns: "1.4fr 1fr 1fr 1fr",
          padding: "14px 20px",
          background: "var(--alc-bg-sunk)",
          borderBottom: "1px solid var(--alc-hairline)",
          fontFamily: "var(--alc-font-mono)", fontSize: 11,
          letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--alc-fg-4)",
        }}>
          <span></span>
          <span style={{ color: "var(--alc-accent-deep)" }}>alchemy</span>
          <span>pulumi / cdk</span>
          <span>sst / cdktf</span>
        </div>
        {rows.map((r, i) => (
          <div key={i} style={{
            display: "grid", gridTemplateColumns: "1.4fr 1fr 1fr 1fr",
            padding: "14px 20px", gap: 12,
            borderBottom: i === rows.length - 1 ? "none" : "1px solid var(--alc-hairline)",
            alignItems: "center",
            fontSize: 14,
          }}>
            <span style={{ color: "var(--alc-fg-1)", fontWeight: 500 }}>{r[0]}</span>
            <code style={{ fontFamily: "var(--alc-font-mono)", fontSize: 12, color: "var(--alc-accent-deep)" }}>{r[1]}</code>
            <span style={{ color: "var(--alc-fg-3)", fontSize: 13 }}>{r[2]}</span>
            <span style={{ color: "var(--alc-fg-3)", fontSize: 13 }}>{r[3]}</span>
          </div>
        ))}
      </div>
    </Section>
  );
}

function EffectCTA() {
  return (
    <Section padding="96px 32px 40px">
      <div style={{ textAlign: "center" }}>
        <Eyebrow>get started</Eyebrow>
        <h2 className="alc-h2" style={{ margin: "12px 0 16px" }}>
          If it compiles, it deploys.
        </h2>
        <p style={{ fontSize: 16, color: "var(--alc-fg-2)", maxWidth: 560, margin: "0 auto 28px" }}>
          Install alchemy alongside your existing Effect project. Start with one Stack.
          Move your infrastructure into code, one Resource at a time.
        </p>
        <div style={{
          display: "inline-flex", alignItems: "stretch",
          background: "var(--alc-bg-code)", borderRadius: 10,
          border: "1px solid var(--alc-hairline)",
          fontFamily: "var(--alc-font-mono)", fontSize: 14,
          overflow: "hidden", margin: "0 0 28px",
        }}>
          <span style={{ padding: "14px 18px", color: "var(--alc-code-comment)" }}>$</span>
          <span style={{ padding: "14px 20px 14px 0", color: "var(--alc-code-var)" }}>
            bun add <span style={{ color: "var(--alc-code-keyword)" }}>alchemy effect</span>
          </span>
        </div>
        <div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
          <Button variant="primary" icon="arrow">Start the tutorial</Button>
          <Button variant="secondary" icon="book">Read the docs</Button>
          <Button variant="ghost" icon="discord">Discord</Button>
        </div>
      </div>
    </Section>
  );
}

Object.assign(window, {
  EffectHero, EffectPrimitivesMap, EffectCodeShowcase,
  EffectObservability, EffectFeatureRow, EffectComparison, EffectCTA,
});
