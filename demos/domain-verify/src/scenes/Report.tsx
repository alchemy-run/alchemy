import { brand, mono } from "../theme.ts";
import { Rise, Scene } from "../ui.tsx";

const TIERS = [
  ["Proved", brand.moss, "every state, every input, any number of commands"],
  ["Checked", brand.gold, "every sequence of 2 commands, every delivery fault"],
  ["Sampled", brand.sky, "200 longer sequences, run on the real model"],
] as const;

/** What a pass tells you, and where to start. */
export const Report = ({ length }: { length: number }) => (
  <Scene kicker="The report" title="Every rule says how far it holds" length={length}>
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {TIERS.map(([name, color, what], index) => (
        <Rise key={name} at={8 + index * 14}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 30,
              borderLeft: `8px solid ${color}`,
              background: brand.bgElevated,
              borderRadius: 14,
              padding: "16px 28px",
            }}
          >
            <div style={{ width: 230, fontSize: 44, fontWeight: 700, color }}>{name}</div>
            <div style={{ fontSize: 30, color: brand.fg }}>{what}</div>
          </div>
        </Rise>
      ))}
    </div>
    <Rise at={70} style={{ marginTop: 70 }}>
      <div style={{ fontFamily: mono, fontSize: 40, color: brand.moss }}>alchemy.run/domain</div>
    </Rise>
  </Scene>
);
