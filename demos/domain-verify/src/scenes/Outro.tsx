import { AbsoluteFill } from "remotion";
import { brand, mono, sans, serif } from "../theme.ts";
import { Rise } from "../ui.tsx";

export const Outro = () => (
  <AbsoluteFill
    style={{
      background: brand.bg,
      color: brand.fg,
      fontFamily: sans,
      justifyContent: "center",
      padding: 140,
    }}
  >
    <Rise at={4}>
      <div style={{ fontFamily: serif, fontSize: 92, lineHeight: 1.1 }}>
        Stories check one example.
      </div>
    </Rise>
    <Rise at={26}>
      <div style={{ fontFamily: serif, fontSize: 92, lineHeight: 1.1, color: brand.moss }}>
        Rules check all of them.
      </div>
    </Rise>
    <Rise at={60}>
      <div
        style={{
          fontFamily: mono,
          fontSize: 32,
          marginTop: 70,
          background: brand.bgElevated,
          border: `1px solid ${brand.border}`,
          borderRadius: 14,
          padding: "20px 28px",
          display: "inline-block",
        }}
      >
        <span style={{ color: brand.fgMuted }}>$ </span>pnpm add -D z3-solver oxc-parser
      </div>
    </Rise>
    <Rise at={84}>
      <div style={{ fontFamily: mono, fontSize: 30, color: brand.fgMuted, marginTop: 34 }}>
        alchemy.run/domain/verifying-models
      </div>
    </Rise>
  </AbsoluteFill>
);
