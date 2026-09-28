import { Img, interpolate, staticFile } from "remotion";
import type { BrowserStep, IntroStep, TerminalStep } from "../../shared/intro.ts";
import { mono, sans } from "../fonts.ts";
import { brand } from "../theme.ts";

/** The same area code slides use, so a cut between code and a pane doesn't jump. */
const AREA = { x: 110, y: 150, width: 1700, height: 880 };
const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

const TrafficLights = () => (
  <div style={{ display: "flex", gap: 9 }}>
    {["#ff5f57", "#febc2e", "#28c840"].map((c) => (
      <div key={c} style={{ width: 13, height: 13, borderRadius: 7, background: c }} />
    ))}
  </div>
);

const Window = ({ children, header }: { children: React.ReactNode; header: React.ReactNode }) => (
  <div
    style={{
      position: "absolute",
      left: AREA.x,
      top: AREA.y,
      width: AREA.width,
      height: AREA.height,
      borderRadius: 14,
      overflow: "hidden",
      background: "#1a1814",
      border: "1px solid #2e2a23",
      boxShadow: "0 30px 80px rgba(0,0,0,0.5)",
      display: "flex",
      flexDirection: "column",
    }}
  >
    <div
      style={{
        height: 52,
        flex: "none",
        display: "flex",
        alignItems: "center",
        gap: 22,
        padding: "0 20px",
        background: "#221f1a",
        borderBottom: "1px solid #2e2a23",
      }}
    >
      <TrafficLights />
      {header}
    </div>
    <div style={{ flex: 1, position: "relative", overflow: "hidden" }}>{children}</div>
  </div>
);

/**
 * A terminal: one command's output so far. Lines carried over from the previous
 * step stay put; only the new ones fade in, top to bottom.
 */
export const TerminalPane = ({ step, prev, local }: { step: TerminalStep; prev?: IntroStep; local: number }) => {
  const same = prev?.kind === "terminal" && prev.group === step.group;
  const firstNew = step.lines.length - step.fresh;
  const size = 26;
  return (
    <Window
      header={
        <div style={{ display: "flex", gap: 6, fontFamily: sans, fontSize: 18 }}>
          {(step.tabs ?? ["terminal"]).map((tab, i) => (
            <div
              key={tab}
              style={{
                padding: "6px 16px",
                borderRadius: 8,
                color: i === (step.active ?? 0) ? brand.fg : brand.fgMuted,
                background: i === (step.active ?? 0) ? "#2e2a23" : "transparent",
              }}
            >
              {tab}
            </div>
          ))}
        </div>
      }
    >
      <div style={{ padding: "26px 32px", fontFamily: mono, fontSize: size, lineHeight: 1.5, whiteSpace: "pre" }}>
        {step.lines.map((line, i) => {
          const isNew = i >= firstNew || !same;
          const at = (i - firstNew) * 2;
          const opacity = isNew ? interpolate(local, [at, at + 4], [0, 1], clamp) : 1;
          return (
            <div key={i} style={{ opacity, minHeight: size * 1.5 }}>
              {line.map((t, k) => (
                <span key={k} style={{ color: t.color, fontWeight: t.bold ? 700 : undefined }}>
                  {t.text}
                </span>
              ))}
            </div>
          );
        })}
      </div>
    </Window>
  );
};

/** A browser window showing one screenshot. A new screenshot cross-fades in. */
export const BrowserPane = ({ step, prev, local }: { step: BrowserStep; prev?: IntroStep; local: number }) => {
  const before = prev?.kind === "browser" && prev.image !== step.image ? prev.image : undefined;
  const p = interpolate(local, [0, 8], [0, 1], clamp);
  return (
    <Window
      header={
        <div
          style={{
            flex: 1,
            maxWidth: 900,
            margin: "0 auto",
            padding: "7px 18px",
            borderRadius: 8,
            background: "#15130f",
            fontFamily: sans,
            fontSize: 18,
            color: brand.fgMuted,
          }}
        >
          {step.url}
        </div>
      }
    >
      {before ? (
        <Img
          src={staticFile(`intro/assets/${before}`)}
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", objectPosition: "top" }}
        />
      ) : null}
      <Img
        src={staticFile(`intro/assets/${step.image}`)}
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          objectFit: "cover",
          objectPosition: "top",
          opacity: prev?.kind === "browser" && !before ? 1 : p,
        }}
      />
    </Window>
  );
};
