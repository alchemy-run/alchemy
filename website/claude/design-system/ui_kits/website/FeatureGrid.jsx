function Feature({ title, body, visual }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <h3 style={{
        fontFamily: "var(--alc-font-sans)", fontSize: 18, fontWeight: 600,
        color: "var(--alc-fg-1)", margin: 0, letterSpacing: "-0.01em",
      }}>{title}</h3>
      <p style={{
        fontFamily: "var(--alc-font-sans)", fontSize: 14, lineHeight: 1.6,
        color: "var(--alc-fg-3)", margin: 0,
      }}>{body}</p>
      <div>{visual}</div>
    </div>
  );
}

function FeatureGrid() {
  return (
    <section style={{ padding: "32px 32px 80px", maxWidth: 1152, margin: "0 auto" }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", columnGap: 48, rowGap: 56 }}>
        <Feature
          title="Type-safe from cloud to code"
          body="The type system ensures every resource has its provider, every binding is wired correctly, and every dependency is satisfied — before you deploy."
          visual={
            <HeroCode>
{T.v("Alchemy")}.{T.f("Stack")}({T.s('"App"')}, {"{"}{"\n"}
{"  "}{T.c("// Type Error: Layer<never> is not")}{"\n"}
{"  "}{T.c("// assignable to Layer<Cloudflare.Providers>")}{"\n"}
{"  "}providers: {T.v("Layer")}.empty,{"\n"}
{"}"}, ...);
            </HeroCode>
          }
        />
        <Feature
          title="Resources are just Effects"
          body="Resources are declared as Effects and composed with yield*. Import them from any file, bind them to Workers, pass outputs to other resources — it's all just TypeScript."
          visual={
            <HeroCode>
{T.k("import")} {"{ Bucket }"} {T.k("from")} {T.s('"./bucket.ts"')};{"\n"}
{"\n"}
{T.k("export default")} {T.v("Cloudflare")}.{T.f("Worker")}({T.s('"Worker"')},{"\n"}
{"  "}{"{ main: "}{T.v("import")}.meta.path{" },"}{"\n"}
{"  "}{T.v("Effect")}.{T.f("gen")}({T.k("function")}* () {"{"}{"\n"}
{"    "}{T.k("const")} b = {T.k("yield")}* {T.v("Cloudflare")}.{T.v("R2Bucket")}.{T.f("bind")}({T.v("Bucket")});{"\n"}
{"  "}{"}"}),{"\n"}
);
            </HeroCode>
          }
        />
        <Feature
          title="Local dev with hot reload"
          body="Run your entire stack locally with a single command. Workers run locally in workerd, and changes hot reload instantly."
          visual={
            <Terminal content={`[d]$[/d] alchemy dev

[g]✓[/g] [b]Bucket[/b] [d](Cloudflare.R2Bucket)[/d] [g]created[/g] [d](local)[/d]
[g]✓[/g] [b]Worker[/b] [d](Cloudflare.Worker)[/d] [g]created[/g] [d](local)[/d]
[s2][d]• http://localhost:1337[/d]

[d]Watching for changes ...[/d]`} />
          }
        />
        <Feature
          title="Plan, deploy, destroy"
          body="Preview what will change with plan, apply it with deploy, and tear it down with destroy. Stages isolate environments so dev and prod never collide."
          visual={
            <Terminal content={`[d]$[/d] alchemy deploy --stage prod

[u]Plan[/u]: [g]2 to create[/g]

[g]+[/g] [b]Bucket[/b] [d](Cloudflare.R2Bucket)[/d]
[g]+[/g] [b]Worker[/b] [d](Cloudflare.Worker)[/d] [c](1 bindings)[/c]

[g]✓[/g] [b]Bucket[/b] [g]created[/g]
[g]✓[/g] [b]Worker[/b] [g]created[/g]`} />
          }
        />
      </div>
    </section>
  );
}

Object.assign(window, { FeatureGrid, Feature });
