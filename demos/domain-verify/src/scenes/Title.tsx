import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { brand, mono, sans, serif } from "../theme.ts";
import { Rise } from "../ui.tsx";

export const Title = ({ length }: { length: number }) => {
  const frame = useCurrentFrame();
  const out = interpolate(frame, [length - 10, length], [1, 0], {
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
      <Rise at={4}>
        <div style={{ fontFamily: mono, fontSize: 28, letterSpacing: 5, color: brand.moss }}>
          @ALCHEMY.RUN/DOMAIN
        </div>
      </Rise>
      <Rise at={12}>
        <div style={{ fontFamily: serif, fontSize: 124, lineHeight: 1.05, marginTop: 28 }}>
          Verifying a model
        </div>
      </Rise>
      <Rise at={30}>
        <div style={{ fontSize: 46, lineHeight: 1.3, color: brand.fgMuted, marginTop: 40 }}>
          Write down what must always be true.
        </div>
      </Rise>
      <Rise at={58}>
        <div style={{ fontSize: 46, lineHeight: 1.3, color: brand.fg }}>
          One test proves it, or finds the commands that break it.
        </div>
      </Rise>
    </AbsoluteFill>
  );
};
