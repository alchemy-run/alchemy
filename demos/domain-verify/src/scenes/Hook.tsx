import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { brand, mono, sans, serif } from "../theme.ts";
import { Rise } from "../ui.tsx";

export const Hook = ({ length }: { length: number }) => {
  const frame = useCurrentFrame();
  const out = interpolate(frame, [length - 8, length], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return (
    <AbsoluteFill
      style={{
        background: brand.bg,
        color: brand.fg,
        fontFamily: sans,
        justifyContent: "center",
        padding: 140,
        opacity: out,
      }}
    >
      <Rise at={2}>
        <div style={{ fontFamily: mono, fontSize: 28, letterSpacing: 5, color: brand.moss }}>
          @ALCHEMY.RUN/DOMAIN
        </div>
      </Rise>
      <Rise at={8}>
        <div style={{ fontFamily: serif, fontSize: 132, lineHeight: 1.05, marginTop: 28 }}>
          Write the rule.
        </div>
      </Rise>
      <Rise at={34}>
        <div style={{ fontFamily: serif, fontSize: 132, lineHeight: 1.05, color: brand.moss }}>
          Get the proof.
        </div>
      </Rise>
    </AbsoluteFill>
  );
};
