import { Img, interpolate, staticFile } from "remotion";
import { BROWSER_VIEWPORT, type SceneCapture } from "../../shared/types.ts";
import { sans } from "../fonts.ts";
import { TrafficLights, Window } from "./Desktop.tsx";
import { TIMING, type SceneSchedule } from "./schedule.ts";

interface Page {
  url: string;
  title: string;
  screenshot: string;
}

interface BrowserState {
  /** Text in the address bar. */
  address: string;
  focused: boolean;
  /** Page on screen (undefined: a new tab). */
  page: Page | undefined;
  /** 0–1 while loading, undefined otherwise. */
  progress: number | undefined;
  /** Opacity of the page that just finished loading. */
  reveal: number;
}

const browserState = (
  capture: SceneCapture,
  plan: SceneSchedule,
  frame: number,
): BrowserState => {
  let state: BrowserState = {
    address: capture.browser?.url ?? "",
    focused: false,
    page: capture.browser,
    progress: undefined,
    reveal: 1,
  };
  for (const segment of plan.segments) {
    if (segment.from > frame) break;
    const { beat } = segment;
    if (beat.kind !== "browser") continue;
    const local = frame - segment.from - segment.switchFrames;
    const typingFrames = TIMING.urlPaste;
    if (local < typingFrames) {
      // Focus the address bar (selecting the old URL), then paste.
      const pasted = local >= typingFrames / 2;
      state = { ...state, address: pasted ? beat.url : "", focused: true, progress: undefined };
    } else if (local < typingFrames + TIMING.pageLoad) {
      state = {
        ...state,
        address: beat.url,
        focused: false,
        progress: (local - typingFrames) / TIMING.pageLoad,
      };
    } else {
      const since = local - typingFrames - TIMING.pageLoad;
      state = {
        address: beat.url,
        focused: false,
        page: beat,
        progress: undefined,
        reveal: interpolate(since, [0, 6], [0, 1], { extrapolateRight: "clamp" }),
      };
    }
  }
  return state;
};

const CHROME_BG = "#202124";
const TAB_BG = "#35363a";

const Icon = ({ d }: { d: string }) => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#c4c7c5" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d={d} />
  </svg>
);

export const Browser = ({
  capture,
  plan,
  frame,
}: {
  capture: SceneCapture;
  plan: SceneSchedule;
  frame: number;
}) => {
  const state = browserState(capture, plan, frame);
  const caretVisible = state.focused && frame % 30 < 18;
  const bar = (
    <div style={{ flex: "none", background: CHROME_BG, fontFamily: sans }}>
      <div style={{ height: 44, display: "flex", alignItems: "flex-end", padding: "0 12px 0 18px", gap: 18 }}>
        <div style={{ alignSelf: "center" }}>
          <TrafficLights />
        </div>
        <div
          style={{
            height: 36,
            width: 260,
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "0 14px",
            borderRadius: "10px 10px 0 0",
            background: TAB_BG,
            color: "#e8eaed",
            fontSize: 14,
          }}
        >
          <div style={{ width: 16, height: 16, borderRadius: 8, background: state.page ? "#8ab4f8" : "#5f6368", flex: "none" }} />
          <span style={{ overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>
            {state.progress !== undefined ? "Loading…" : (state.page?.title ?? "New Tab")}
          </span>
        </div>
        <span style={{ alignSelf: "center", color: "#c4c7c5", fontSize: 22 }}>+</span>
      </div>
      <div style={{ height: 48, display: "flex", alignItems: "center", gap: 14, padding: "0 16px", background: TAB_BG, position: "relative" }}>
        <Icon d="M19 12H5M12 19l-7-7 7-7" />
        <Icon d="M5 12h14M12 5l7 7-7 7" />
        <Icon d="M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5" />
        <div
          style={{
            flex: 1,
            height: 34,
            borderRadius: 17,
            background: state.focused ? "#202124" : "#282a2d",
            outline: state.focused ? "2px solid #8ab4f8" : undefined,
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "0 16px",
            color: "#e8eaed",
            fontSize: 16,
          }}
        >
          <Icon d="M7 11V8a5 5 0 0 1 10 0v3M5 11h14v10H5z" />
          <span>
            {state.address}
            {caretVisible ? <span style={{ borderLeft: "2px solid #e8eaed", marginLeft: 1 }} /> : null}
          </span>
        </div>
        {state.progress !== undefined ? (
          <div
            style={{
              position: "absolute",
              left: 0,
              bottom: 0,
              height: 3,
              width: `${Math.round(state.progress * 100)}%`,
              background: "#8ab4f8",
            }}
          />
        ) : null}
      </div>
    </div>
  );
  return (
    <Window background="#ffffff" bar={bar}>
      <div style={{ position: "absolute", inset: 0, background: "#202124" }}>
        {state.page ? (
          <Img
            src={staticFile(state.page.screenshot)}
            style={{
              width: BROWSER_VIEWPORT.width,
              height: BROWSER_VIEWPORT.height,
              display: "block",
              opacity: state.reveal,
            }}
          />
        ) : null}
      </div>
    </Window>
  );
};
