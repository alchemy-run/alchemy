import type { CSSProperties, ReactNode } from "react";
import { AbsoluteFill, interpolate, spring, useVideoConfig } from "remotion";
import { TITLE_BAR, WINDOW, type AppId } from "../../shared/types.ts";
import { sans } from "../fonts.ts";
import { brand } from "../theme.ts";

export const APP_NAMES: Record<AppId, string> = {
  editor: "Code",
  terminal: "Terminal",
  browser: "Google Chrome",
};

/** Dark wallpaper with the brand's moss and ember glows. */
export const Wallpaper = () => (
  <AbsoluteFill
    style={{
      background: [
        `radial-gradient(1200px 800px at 12% 18%, ${brand.moss}33, transparent 60%)`,
        `radial-gradient(1000px 700px at 88% 85%, ${brand.ember}2e, transparent 60%)`,
        `linear-gradient(160deg, #1b1712, ${brand.bg} 55%, #0d0b08)`,
      ].join(","),
    }}
  />
);

export const MenuBar = ({ app }: { app: AppId }) => (
  <div
    style={{
      position: "absolute",
      inset: "0 0 auto 0",
      height: 34,
      display: "flex",
      alignItems: "center",
      gap: 26,
      padding: "0 22px",
      background: "rgba(20, 17, 13, 0.55)",
      backdropFilter: "blur(20px)",
      color: "#f2ede2",
      fontFamily: sans,
      fontSize: 15,
    }}
  >
    <AlchemyMark size={18} />
    <span style={{ fontWeight: 700 }}>{APP_NAMES[app]}</span>
    {["File", "Edit", "View", "Window", "Help"].map((item) => (
      <span key={item} style={{ opacity: 0.85 }}>
        {item}
      </span>
    ))}
    <span style={{ marginLeft: "auto", opacity: 0.85 }}>Tue 9:41 AM</span>
  </div>
);

export const AlchemyMark = ({ size, style }: { size: number; style?: CSSProperties }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke={brand.moss}
    strokeWidth={1.4}
    strokeLinecap="round"
    strokeLinejoin="round"
    style={style}
  >
    <circle cx="12" cy="12" r="9.5" />
    <path d="M12 21.225 L4.0109 7.3875 L19.9891 7.3875 Z" />
    <circle cx="12" cy="12" r="1.3" fill={brand.ember} stroke="none" />
  </svg>
);

const TrafficLights = () => (
  <div style={{ display: "flex", gap: 9 }}>
    {["#ff5f57", "#febc2e", "#28c840"].map((color) => (
      <div
        key={color}
        style={{ width: 13, height: 13, borderRadius: 7, background: color }}
      />
    ))}
  </div>
);

/** A macOS window at the shared window frame. `bar` replaces the default title bar (browser tabs). */
export const Window = ({
  title,
  background,
  bar,
  style,
  children,
}: {
  title?: string;
  background: string;
  bar?: ReactNode;
  style?: CSSProperties;
  children: ReactNode;
}) => (
  <div
    style={{
      position: "absolute",
      left: WINDOW.x,
      top: WINDOW.y,
      width: WINDOW.width,
      height: WINDOW.height,
      borderRadius: 12,
      overflow: "hidden",
      background,
      boxShadow:
        "0 0 0 1px rgba(255,255,255,0.09), 0 30px 80px rgba(0,0,0,0.55), 0 8px 24px rgba(0,0,0,0.35)",
      display: "flex",
      flexDirection: "column",
      ...style,
    }}
  >
    {bar ?? (
      <div
        style={{
          height: TITLE_BAR,
          flex: "none",
          display: "flex",
          alignItems: "center",
          padding: "0 18px",
          position: "relative",
          borderBottom: "1px solid rgba(255,255,255,0.06)",
        }}
      >
        <TrafficLights />
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "grid",
            placeItems: "center",
            color: "#a0a0a0",
            fontFamily: sans,
            fontSize: 14,
            fontWeight: 500,
            pointerEvents: "none",
          }}
        >
          {title}
        </div>
      </div>
    )}
    <div style={{ flex: 1, position: "relative", overflow: "hidden" }}>{children}</div>
  </div>
);

export { TrafficLights };

const AppIcon = ({ app, size }: { app: AppId; size: number }) => {
  const radius = size * 0.225;
  if (app === "editor") {
    return (
      <svg width={size} height={size} viewBox="0 0 100 100">
        <rect width="100" height="100" rx={radius} fill="#1f1f1f" />
        <path d="M70 18 L84 25 V75 L70 82 L34 50 Z" fill="#0065a9" />
        <path d="M70 18 L30 55 L18 46 L14 50 L30 64 L70 82 Z" fill="#007acc" />
        <path d="M70 18 V82 L84 75 V25 Z" fill="#1f9cf0" />
      </svg>
    );
  }
  if (app === "terminal") {
    return (
      <svg width={size} height={size} viewBox="0 0 100 100">
        <rect width="100" height="100" rx={radius} fill="#2b2b2b" />
        <rect x="6" y="6" width="88" height="88" rx={radius - 4} fill="#111" />
        <path d="M24 36 L40 50 L24 64" stroke="#e6e6e6" strokeWidth="7" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M46 66 H70" stroke="#e6e6e6" strokeWidth="7" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg width={size} height={size} viewBox="0 0 100 100">
      <rect width="100" height="100" rx={radius} fill="#f4f4f4" />
      <circle cx="50" cy="50" r="34" fill="#db4437" />
      <path d="M50 50 L79.4 67 A34 34 0 0 1 20.6 67 Z" fill="#0f9d58" />
      <path d="M50 50 L50 16 A34 34 0 0 1 79.4 67 Z" fill="#f4b400" />
      <circle cx="50" cy="50" r="15" fill="#fff" />
      <circle cx="50" cy="50" r="11.5" fill="#4285f4" />
    </svg>
  );
};

const SWITCHER_ORDER: AppId[] = ["editor", "terminal", "browser"];

/** The Cmd-Tab app switcher, `frame` frames into a switch from `from` to `to`. */
export const AppSwitcher = ({
  frame,
  duration,
  from,
  to,
}: {
  frame: number;
  duration: number;
  from: AppId;
  to: AppId;
}) => {
  const { fps } = useVideoConfig();
  const opacity = interpolate(frame, [0, 3, duration - 3, duration], [0, 1, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const scale = 0.96 + 0.04 * spring({ frame, fps, config: { damping: 18, stiffness: 220 } });
  const selected = frame < 5 ? from : to;
  const icon = 112;
  return (
    <AbsoluteFill style={{ display: "grid", placeItems: "center", opacity }}>
      <div
        style={{
          transform: `scale(${scale})`,
          display: "flex",
          gap: 18,
          padding: 22,
          borderRadius: 28,
          background: "rgba(40, 38, 36, 0.72)",
          backdropFilter: "blur(30px)",
          boxShadow: "0 0 0 1px rgba(255,255,255,0.1), 0 20px 60px rgba(0,0,0,0.5)",
        }}
      >
        {SWITCHER_ORDER.map((app) => (
          <div
            key={app}
            style={{
              padding: 12,
              borderRadius: 22,
              background: app === selected ? "rgba(255,255,255,0.16)" : "transparent",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 8,
            }}
          >
            <AppIcon app={app} size={icon} />
            <span
              style={{
                fontFamily: sans,
                fontSize: 15,
                color: "#eee",
                opacity: app === selected ? 1 : 0,
              }}
            >
              {APP_NAMES[app]}
            </span>
          </div>
        ))}
      </div>
    </AbsoluteFill>
  );
};
