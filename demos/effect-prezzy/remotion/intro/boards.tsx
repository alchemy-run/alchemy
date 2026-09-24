import type { ReactNode } from "react";
import { AbsoluteFill, interpolate } from "remotion";
import { hand, mono, sans, serif } from "../fonts.ts";
import { brand, vscode } from "../theme.ts";
import { Arrow, drawProgress, TONE } from "./draw.tsx";

/**
 * Conceptual diagrams for the intro. Each board has numbered stages; a
 * stage is one presenter step. `local` is frames since the stage began,
 * so the new part of a stage animates in and earlier parts stay put.
 */
export interface BoardProps {
  stage: number;
  local: number;
}

const fadeIn = (local: number, delay = 0, frames = 12) =>
  interpolate(local, [delay, delay + frames], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

/** Visible in stage `from` onward; animates only in the stage it first appears. */
const shown = (stage: number, from: number, local: number, delay = 0) =>
  stage > from ? 1 : stage === from ? fadeIn(local, delay) : 0;

const Label = ({ children, color = brand.fgMuted, size = 28 }: { children: ReactNode; color?: string; size?: number }) => (
  <div style={{ fontFamily: sans, fontSize: size, color }}>{children}</div>
);

const Node = ({
  x,
  y,
  title,
  kind,
  color,
  opacity = 1,
  w = 230,
  h = 96,
  children,
}: {
  x: number;
  y: number;
  title: string;
  kind?: string;
  color: string;
  opacity?: number;
  w?: number;
  h?: number;
  children?: ReactNode;
}) => (
  <div
    style={{
      position: "absolute",
      left: x - w / 2,
      top: y - h / 2,
      width: w,
      minHeight: h,
      padding: "16px 20px",
      borderRadius: 16,
      background: "#1c1a17",
      border: `2px solid ${color}`,
      boxShadow: "0 12px 30px rgba(0,0,0,0.4)",
      opacity,
      transform: `scale(${0.9 + 0.1 * opacity})`,
      fontFamily: sans,
    }}
  >
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <span style={{ width: 11, height: 11, borderRadius: 6, background: color }} />
      <span style={{ color: brand.fg, fontSize: 30, fontWeight: 600 }}>{title}</span>
    </div>
    {kind ? <div style={{ color: brand.fgMuted, fontSize: 18, marginTop: 6 }}>{kind}</div> : null}
    {children}
  </div>
);

const Svg = ({ children }: { children: ReactNode }) => (
  <svg width={1920} height={1080} style={{ position: "absolute", left: 0, top: 0, overflow: "visible" }}>
    {children}
  </svg>
);

const CodeCard = ({ x, y, w, text, color, opacity }: { x: number; y: number; w: number; text: string; color: string; opacity: number }) => (
  <pre
    style={{
      position: "absolute",
      left: x,
      top: y,
      width: w,
      margin: 0,
      padding: "16px 20px",
      background: vscode.editorBg,
      border: `2px solid ${color}`,
      borderRadius: 12,
      fontFamily: mono,
      fontSize: 24,
      lineHeight: 1.45,
      color: "#d4d4d4",
      opacity,
      whiteSpace: "pre-wrap",
    }}
  >
    {text}
  </pre>
);

// ── Act 1: a cloud program's world ───────────────────────────────────────
const WORLD = {
  fn: { x: 1150, y: 360, title: "Function", color: "#f38020" },
  db: { x: 1560, y: 290, title: "Database", color: "#00e599" },
  bucket: { x: 1560, y: 560, title: "Bucket", color: "#8b7cf6" },
  queue: { x: 1150, y: 650, title: "Queue", color: "#e0a86b" },
};

const World = ({ stage, local }: BoardProps) => {
  const graph = shown(stage, 1, local);
  const edge = (i: number) => (stage > 1 ? 1 : stage === 1 ? drawProgress(local, 14 + i * 6) : 0);
  // Stage 2 zooms into the bucket's config; stage 3 into the function → bucket edge.
  const versions = ["versioning: off", "versioning: on", "versioning: on\ncors: [app.shorty.dev]"];
  const v = stage === 2 ? Math.min(2, Math.floor(Math.max(0, local - 6) / 18)) : 2;
  return (
    <AbsoluteFill>
      {/* left: an ordinary program */}
      <div style={{ position: "absolute", left: 120, top: 150, width: 640 }}>
        <Label color={brand.fg} size={34}>
          An ordinary program
        </Label>
        <Svg>
          {stroke2(`M 150 330 L 710 330`, brand.fgMuted, drawProgress(local, 4, 20))}
        </Svg>
        <div style={{ position: "absolute", left: 30, top: 130, fontFamily: mono, fontSize: 26, color: brand.fgMuted }}>
          main()
        </div>
        <div style={{ position: "absolute", left: 540, top: 130, fontFamily: mono, fontSize: 26, color: brand.fgMuted }}>
          exit
        </div>
        <div style={{ position: "absolute", left: 30, top: 240, width: 600 }}>
          <Label>Runs from entry point to exit. When it's done, its state is gone.</Label>
        </div>
      </div>
      {/* right: a cloud program's world */}
      <div style={{ position: "absolute", left: 960, top: 150 }}>
        <Label color={brand.fg} size={34}>
          A cloud program
        </Label>
      </div>
      <div
        style={{
          position: "absolute",
          left: 940,
          top: 210,
          width: 860,
          height: 600,
          borderRadius: 28,
          border: `2px dashed ${brand.fgMuted}55`,
          opacity: fadeIn(local, 6),
        }}
      />
      <div style={{ position: "absolute", left: 970, top: 770, opacity: fadeIn(local, 10) }}>
        <Label>…leaves a world behind that the next run starts from.</Label>
      </div>
      <Svg>
        <g opacity={graph}>
          <Arrow x1={1270} y1={360} x2={1440} y2={300} color={brand.fgMuted} progress={edge(0)} bend={0.1} />
          <Arrow x1={1270} y1={390} x2={1440} y2={540} color={stage >= 3 ? TONE.construct : brand.fgMuted} progress={edge(1)} bend={-0.1} />
          <Arrow x1={1150} y1={600} x2={1150} y2={420} color={brand.fgMuted} progress={edge(2)} bend={0.2} />
        </g>
      </Svg>
      {(Object.keys(WORLD) as (keyof typeof WORLD)[]).map((key, i) => {
        const n = WORLD[key];
        const dim = stage === 2 && key !== "bucket" ? 0.35 : stage === 3 && key !== "fn" && key !== "bucket" ? 0.35 : 1;
        return (
          <Node
            key={key}
            x={n.x}
            y={n.y}
            title={n.title}
            color={n.color}
            opacity={(stage > 1 ? 1 : stage === 1 ? fadeIn(local, i * 5) : stage === 0 ? fadeIn(local, 16 + i * 4) * 0.9 : 0) * dim}
          />
        );
      })}
      {stage === 2 ? (
        <div style={{ position: "absolute", left: 1450, top: 640, width: 360 }}>
          <CodeCard x={0} y={0} w={330} text={versions[v]!} color={TONE.construct} opacity={fadeIn(local, 4)} />
          <div style={{ position: "absolute", left: 0, top: 150, fontFamily: hand, fontSize: 34, color: TONE.construct, opacity: fadeIn(local, 30) }}>
            desired ≠ actual → reconcile
          </div>
        </div>
      ) : null}
      {stage === 3 ? (
        <>
          <CodeCard
            x={150}
            y={470}
            w={560}
            text={`{ "Effect": "Allow",\n  "Action": "s3:GetObject",\n  "Resource": "arn:…:bucket/*" }`}
            color={TONE.construct}
            opacity={fadeIn(local, 8)}
          />
          <CodeCard x={150} y={650} w={560} text="BUCKET_NAME=uploads-7f3a" color={TONE.construct} opacity={fadeIn(local, 16)} />
          <Svg>
            <Arrow x1={720} y1={560} x2={1330} y2={470} color={TONE.construct} progress={drawProgress(local, 20, 16)} bend={-0.15} />
          </Svg>
          <div style={{ position: "absolute", left: 160, top: 740, fontFamily: hand, fontSize: 48, fontWeight: 700, color: TONE.construct, opacity: fadeIn(local, 26) }}>
            = a binding
          </div>
        </>
      ) : null}
    </AbsoluteFill>
  );
};

const stroke2 = (d: string, color: string, progress: number) => (
  <path d={d} fill="none" stroke={color} strokeWidth={4} strokeLinecap="round" strokeDasharray={4000} strokeDashoffset={4000 * (1 - progress)} />
);

// ── Act 2: phases ────────────────────────────────────────────────────────
const Phases = ({ stage, local }: BoardProps) => {
  const col = (x: number, tone: "construct" | "runtime", title: string, lines: string[], delay: number) => (
    <div
      style={{
        position: "absolute",
        left: x,
        top: 170,
        width: 700,
        padding: "34px 40px",
        borderRadius: 24,
        border: `2px solid ${TONE[tone]}`,
        background: `${TONE[tone]}10`,
        opacity: stage > 0 ? 1 : fadeIn(local, delay),
        fontFamily: sans,
      }}
    >
      <div style={{ fontFamily: serif, fontSize: 60, fontWeight: 600, color: TONE[tone] }}>{title}</div>
      {lines.map((line, i) => (
        <div key={i} style={{ marginTop: 20, fontSize: 36, color: brand.fg, opacity: stage > 0 ? 1 : fadeIn(local, delay + 8 + i * 5) }}>
          {line}
        </div>
      ))}
    </div>
  );
  return (
    <AbsoluteFill>
      {col(180, "construct", "Construction", ["Declarative", "Builds the static architecture", "Resources and bindings"], 0)}
      {col(1040, "runtime", "Runtime", ["Dynamic, imperative", "Requests and jobs", "Reads, writes, API calls"], 12)}
      <div style={{ position: "absolute", left: 180, top: 640, width: 1560, opacity: stage > 0 ? 1 : fadeIn(local, 34) }}>
        <Svg>
          {stroke2("M 200 720 L 1740 720", brand.fgMuted, stage > 0 ? 1 : drawProgress(local, 34, 20))}
        </Svg>
        <div style={{ position: "absolute", left: 60, top: 100, display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ padding: "6px 14px", borderRadius: 8, background: TONE.construct, color: "#14110d", fontFamily: mono, fontSize: 20, fontWeight: 700 }}>
            deploy
          </span>
          <Label>construct once</Label>
        </div>
        <div style={{ position: "absolute", left: 760, top: 100, display: "flex", gap: 10 }}>
          {Array.from({ length: 9 }, (_, i) => (
            <span key={i} style={{ width: 54, height: 30, borderRadius: 8, background: `${TONE.runtime}${i % 2 ? "99" : "cc"}` }} />
          ))}
        </div>
        <div style={{ position: "absolute", left: 1000, top: 150 }}>
          <Label>run many times</Label>
        </div>
      </div>
      {stage >= 1 ? (
        <Svg>
          <Arrow x1={1060} y1={470} x2={880} y2={420} color={TONE.runtime} progress={drawProgress(local, 4, 18)} bend={0.2} />
          <text x={900} y={520} fontFamily={hand} fontSize={40} fontWeight={700} fill={TONE.runtime} opacity={fadeIn(local, 18)}>
            refers to what construction declared
          </text>
        </Svg>
      ) : null}
    </AbsoluteFill>
  );
};

// ── Act 3: history ───────────────────────────────────────────────────────
const History = ({ local }: BoardProps) => {
  const items = [
    { year: "2018–19", name: "Punchcard", body: "Two phases on top of the AWS CDK", tone: "neutral" as const },
    { year: "later", name: "Functionless", body: "TypeScript compiled by reading its AST", tone: "neutral" as const },
    { year: "now", name: "Alchemy", body: "Infrastructure as Effects", tone: "construct" as const },
  ];
  return (
    <AbsoluteFill>
      <Svg>{stroke2("M 260 540 L 1660 540", brand.fgMuted, drawProgress(local, 0, 24))}</Svg>
      {items.map((item, i) => {
        const x = 330 + i * 630;
        const p = fadeIn(local, 10 + i * 10);
        return (
          <div key={item.name} style={{ position: "absolute", left: x - 180, top: 400, width: 360, textAlign: "center", opacity: p }}>
            <div style={{ fontFamily: mono, fontSize: 24, color: brand.fgMuted }}>{item.year}</div>
            <div
              style={{
                margin: "44px auto 0",
                width: 26,
                height: 26,
                borderRadius: 13,
                background: TONE[item.tone],
              }}
            />
            <div style={{ marginTop: 40, fontFamily: serif, fontSize: 52, fontWeight: 600, color: item.tone === "construct" ? TONE.construct : brand.fg }}>
              {item.name}
            </div>
            <div style={{ marginTop: 10 }}>
              <Label size={24}>{item.body}</Label>
            </div>
          </div>
        );
      })}
    </AbsoluteFill>
  );
};

// ── Act 4: Context.Service + Layer ───────────────────────────────────────
const Layers = ({ local }: BoardProps) => (
  <AbsoluteFill>
    <CodeCard
      x={170}
      y={260}
      w={620}
      text={`class Storage extends Context.Service<\n  Storage,\n  { get(key: string): Effect<Buffer> }\n>()("Storage") {}`}
      color={TONE.construct}
      opacity={fadeIn(local, 0)}
    />
    <div style={{ position: "absolute", left: 170, top: 200, opacity: fadeIn(local, 0) }}>
      <Label color={TONE.construct} size={30}>
        The interface
      </Label>
    </div>
    <CodeCard
      x={1130}
      y={260}
      w={620}
      text={`const StorageS3 = Layer.effect(\n  Storage,\n  Effect.gen(function* () {\n    // resources, bindings…\n    return { get: … }\n  }),\n)`}
      color={TONE.runtime}
      opacity={fadeIn(local, 12)}
    />
    <div style={{ position: "absolute", left: 1130, top: 200, opacity: fadeIn(local, 12) }}>
      <Label color={TONE.runtime} size={30}>
        One implementation
      </Label>
    </div>
    <CodeCard
      x={560}
      y={660}
      w={800}
      text={`program.pipe(Effect.provide(StorageS3))`}
      color={brand.fgMuted}
      opacity={fadeIn(local, 26)}
    />
    <Svg>
      <Arrow x1={480} y1={500} x2={700} y2={650} color={brand.fgMuted} progress={drawProgress(local, 30, 16)} bend={0.1} />
      <Arrow x1={1440} y1={560} x2={1220} y2={650} color={brand.fgMuted} progress={drawProgress(local, 36, 16)} bend={-0.1} />
      <text x={960} y={820} textAnchor="middle" fontFamily={hand} fontSize={42} fontWeight={700} fill={TONE.construct} opacity={fadeIn(local, 48)}>
        they only meet where you provide it
      </text>
    </Svg>
  </AbsoluteFill>
);

// ── Act 4: the implementation wires permissions ──────────────────────────
const Fork = ({ local }: BoardProps) => {
  const branch = (x: number, title: string, lines: string[], delay: number, tone: "construct" | "runtime") => (
    <div style={{ position: "absolute", left: x, top: 460, width: 700, opacity: fadeIn(local, delay) }}>
      <div style={{ fontFamily: serif, fontSize: 44, fontWeight: 600, color: TONE[tone] }}>{title}</div>
      {lines.map((line, i) => (
        <div key={i} style={{ marginTop: 18, display: "flex", gap: 14, fontFamily: sans, fontSize: 31, color: brand.fg, opacity: fadeIn(local, delay + 6 + i * 6) }}>
          <span style={{ color: TONE[tone] }}>→</span>
          {line}
        </div>
      ))}
    </div>
  );
  return (
    <AbsoluteFill>
      <div
        style={{
          position: "absolute",
          left: 660,
          top: 150,
          width: 600,
          padding: "22px 28px",
          textAlign: "center",
          borderRadius: 16,
          border: `2px solid ${brand.fgMuted}`,
          fontFamily: mono,
          fontSize: 30,
          color: brand.fg,
          opacity: fadeIn(local, 0),
        }}
      >
        AWS.S3.GetObjectHttp
      </div>
      <Svg>
        <Arrow x1={880} y1={250} x2={520} y2={440} color={TONE.construct} progress={drawProgress(local, 8, 16)} bend={0.1} />
        <Arrow x1={1040} y1={250} x2={1400} y2={440} color={TONE.runtime} progress={drawProgress(local, 14, 16)} bend={-0.1} />
      </Svg>
      {branch(200, "On Lambda", ["Adds s3:GetObject on this bucket", "to the Function's IAM role", "Uses the Function's credentials"], 20, "construct")}
      {branch(1080, "On a Cloudflare Worker", ["Creates an IAM user that can only assume a role", "Binds its keys to the Worker", "Fetches short-lived credentials at runtime"], 32, "runtime")}
    </AbsoluteFill>
  );
};

// ── Act 5: the compiler pipeline ─────────────────────────────────────────
const Pipeline = ({ local }: BoardProps) => {
  const stages = [
    { title: "TypeScript", body: "checks Effect<A, Err, Req>\nand Layer<Out, Err, In>" },
    { title: "Run the program", body: "builds the graph of\nresources and bindings" },
    { title: "Plan", body: "diff the graph against\nwhat's deployed" },
    { title: "Apply", body: "converge the cloud,\nafter you review it" },
  ];
  return (
    <AbsoluteFill>
      {stages.map((s, i) => {
        const x = 105 + i * 435;
        return (
          <div key={s.title}>
            <div
              style={{
                position: "absolute",
                left: x,
                top: 380,
                width: 395,
                height: 280,
                padding: "30px 28px",
                borderRadius: 20,
                border: `2px solid ${i === 0 ? TONE.construct : brand.fgMuted}88`,
                background: "#1c1a17",
                opacity: fadeIn(local, i * 12),
              }}
            >
              <div style={{ fontFamily: serif, fontSize: 38, fontWeight: 600, whiteSpace: "nowrap", color: i === 0 ? TONE.construct : brand.fg }}>{s.title}</div>
              <div style={{ marginTop: 18, fontFamily: sans, fontSize: 28, lineHeight: 1.4, color: brand.fgMuted, whiteSpace: "pre-line" }}>{s.body}</div>
            </div>
            {i < stages.length - 1 ? (
              <Svg>
                <Arrow x1={x + 398} y1={520} x2={x + 432} y2={520} color={brand.fgMuted} progress={drawProgress(local, i * 12 + 8, 10)} bend={0} />
              </Svg>
            ) : null}
          </div>
        );
      })}
      <div style={{ position: "absolute", left: 0, right: 0, top: 730, textAlign: "center", fontFamily: hand, fontSize: 44, fontWeight: 700, color: TONE.construct, opacity: fadeIn(local, 54) }}>
        the type system does the static analysis
      </div>
    </AbsoluteFill>
  );
};

// ── Act 6: components ────────────────────────────────────────────────────
const Components = ({ stage, local }: BoardProps) => {
  const tools = ["Terraform module", "CDK construct", "Pulumi component"];
  return (
    <AbsoluteFill>
      {tools.map((tool, i) => {
        const x = 170 + i * 560;
        return (
          <div key={tool} style={{ position: "absolute", left: x, top: 220, width: 460, opacity: stage > 0 ? 1 : fadeIn(local, i * 8) }}>
            <div style={{ fontFamily: serif, fontSize: 36, fontWeight: 600, color: brand.fg }}>{tool}</div>
            <div style={{ marginTop: 16, padding: 20, height: 230, borderRadius: 18, border: `2px solid ${brand.fgMuted}88`, display: "flex", flexWrap: "wrap", gap: 12, alignContent: "flex-start" }}>
              {["Function", "Role", "Policy", "Table", "Queue"].map((r) => (
                <span key={r} style={{ padding: "8px 14px", borderRadius: 10, background: "rgba(255,255,255,0.07)", fontFamily: mono, fontSize: 20, color: brand.fgMuted }}>
                  {r}
                </span>
              ))}
            </div>
            {stage >= 1 ? (
              <div style={{ marginTop: 60, opacity: fadeIn(local, 6 + i * 6) }}>
                <pre
                  style={{
                    margin: 0,
                    padding: 18,
                    borderRadius: 12,
                    border: `2px dashed ${TONE.bad}`,
                    fontFamily: mono,
                    fontSize: 19,
                    color: "#d4d4d4",
                  }}
                >
                  {`handler = async (e) => {\n  await table.get(…)\n}`}
                </pre>
                <div style={{ marginTop: 10, fontFamily: hand, fontSize: 34, fontWeight: 700, color: TONE.bad }}>runtime code lives outside</div>
              </div>
            ) : null}
          </div>
        );
      })}
    </AbsoluteFill>
  );
};

const BOARDS: Record<string, (p: BoardProps) => ReactNode> = {
  world: World,
  phases: Phases,
  history: History,
  layers: Layers,
  fork: Fork,
  pipeline: Pipeline,
  components: Components,
};

export const Board = ({ board, stage, local }: { board: string; stage: number; local: number }) => {
  const View = BOARDS[board];
  if (!View) throw new Error(`no intro board "${board}"`);
  return <View stage={stage} local={local} />;
};
