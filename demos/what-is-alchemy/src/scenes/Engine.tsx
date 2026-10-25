import { AbsoluteFill } from "remotion";
import { progress } from "../anim.ts";
import { color, font } from "../theme.ts";

/** The compare page's engine diagram: what sits between your code and the cloud. */
const TOOLS = [
  {
    tool: "Alchemy",
    file: "alchemy.run.ts",
    note: "1 runtime · TypeScript",
    layers: [{ name: "Alchemy", sub: "TypeScript + Effect" }],
    ours: true,
  },
  {
    tool: "SST",
    file: "sst.config.ts",
    note: "3 layers · TypeScript → Go",
    layers: [
      { name: "SST", sub: "Go CLI" },
      { name: "Pulumi engine", sub: "Go" },
      { name: "Terraform provider", sub: "Go, through a bridge" },
    ],
  },
  {
    tool: "Pulumi",
    file: "index.ts",
    note: "2 layers · gRPC between them",
    layers: [
      { name: "Pulumi engine", sub: "Go" },
      { name: "Provider plugin", sub: "often a bridged Terraform provider" },
    ],
  },
  {
    tool: "Terraform",
    file: "main.tf",
    note: "2 layers · HCL → Go",
    layers: [
      { name: "Terraform core", sub: "Go" },
      { name: "Provider plugin", sub: "Go" },
    ],
  },
];
const COL = 420;
const X0 = 120;

const Nest = ({ layers, ours }: { layers: { name: string; sub: string }[]; ours?: boolean }) => {
  const [head, ...rest] = layers;
  if (!head) return null;
  return (
    <div
      style={{
        padding: "16px 16px",
        borderRadius: 14,
        border: `2px solid ${ours ? color.moss : color.hairline}`,
        background: ours
          ? `color-mix(in srgb, ${color.moss} 10%, transparent)`
          : "rgba(255,255,255,0.02)",
      }}
    >
      <div style={{ fontFamily: font.sans, fontWeight: 600, fontSize: 24, color: color.fg }}>
        {head.name}
      </div>
      <div
        style={{
          fontFamily: font.mono,
          fontSize: 16,
          color: color.muted,
          marginTop: 4,
          marginBottom: rest.length ? 14 : 0,
        }}
      >
        {head.sub}
      </div>
      {rest.length > 0 && <Nest layers={rest} />}
    </div>
  );
};

const Pillbox = ({ children, c }: { children: string; c: string }) => (
  <div
    style={{
      alignSelf: "center",
      padding: "6px 16px",
      borderRadius: 999,
      border: `2px solid ${c}`,
      fontFamily: font.mono,
      fontSize: 20,
      color: c,
    }}
  >
    {children}
  </div>
);
const Down = () => (
  <div style={{ alignSelf: "center", width: 2, height: 34, background: color.hairline }} />
);

export const Engine = ({ t }: { t: number }) => (
  <AbsoluteFill>
    {TOOLS.map((tool, k) => {
      const p = progress(t, k * 6, 14);
      return (
        <div
          key={tool.tool}
          style={{
            position: "absolute",
            left: X0 + k * COL,
            top: 280,
            width: COL - 50,
            display: "flex",
            flexDirection: "column",
            gap: 10,
            opacity: p,
            transform: `translateY(${(1 - p) * 30}px)`,
          }}
        >
          <div
            style={{
              fontFamily: font.serif,
              fontWeight: 600,
              fontSize: 40,
              color: tool.ours ? color.moss : color.fg,
              textAlign: "center",
            }}
          >
            {tool.tool}
          </div>
          <Pillbox c={color.muted}>{tool.file}</Pillbox>
          <Down />
          <Nest layers={tool.layers} ours={tool.ours} />
          <Down />
          <Pillbox c={color.fg}>Cloud API</Pillbox>
          <div
            style={{
              fontFamily: font.mono,
              fontSize: 20,
              color: tool.ours ? color.moss : color.muted,
              textAlign: "center",
              marginTop: 10,
            }}
          >
            {tool.note}
          </div>
        </div>
      );
    })}
  </AbsoluteFill>
);
