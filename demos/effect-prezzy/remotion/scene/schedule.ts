import type { AppId, Beat, SceneCapture } from "../../shared/types.ts";
import { highlight, type Colors } from "./highlight.ts";
import { planTyping, type TypingPlan } from "./typing.ts";

/** Frame budget for each kind of beat, at `fps`. */
export const TIMING = {
  /** Cmd-Tab: switcher overlay, then the target window comes forward. */
  switch: 20,
  switchOverlay: 13,
  /** Frames the picked window takes to come forward after the switcher closes. */
  raise: 3,
  openTab: 14,
  editLeadIn: 10,
  editHold: 14,
  typing: { cps: 34, selectFrames: 10, gapFrames: 8 },
  /** Click the address bar, paste, press Enter. */
  urlPaste: 14,
  pageLoad: 18,
  browserHold: 12,
} as const;

export interface Segment {
  beat: Beat;
  from: number;
  duration: number;
  /** The window in front during this segment. */
  app: AppId;
  /** The window in front before it; differs from `app` when the segment starts with a switch. */
  previous: AppId;
  /** Frames at the start spent switching windows (0 when already focused). */
  switchFrames: number;
  /** editor.edit: the typing plan and token colours of both versions. */
  typing?: { plan: TypingPlan; before: Colors; after: Colors };
  /** editor.open: token colours of the opened file. */
  colors?: Colors;
}

export interface SceneSchedule {
  segments: Segment[];
  /** Colours of the tabs open when the scene starts. */
  initialColors: Record<string, Colors>;
  durationInFrames: number;
}

const appOf = (beat: Beat, current: AppId): AppId => {
  switch (beat.kind) {
    case "focus":
      return beat.app;
    case "editor.open":
    case "editor.edit":
      return "editor";
    case "terminal":
      return "terminal";
    case "browser":
      return "browser";
    case "pause":
      return current;
  }
};

export const schedule = async (
  capture: SceneCapture,
  fps: number,
): Promise<SceneSchedule> => {
  const segments: Segment[] = [];
  let frame = 0;
  // The scene opens on the first beat's window, without a switch.
  const firstBeat = capture.beats.find((b) => b.kind !== "pause");
  let app: AppId = firstBeat ? appOf(firstBeat, "editor") : "editor";
  for (const beat of capture.beats) {
    const next = appOf(beat, app);
    const switchFrames = next === app ? 0 : TIMING.switch;
    const segment: Segment = {
      beat,
      from: frame,
      duration: 0,
      app: next,
      previous: app,
      switchFrames,
    };
    let work = 0;
    switch (beat.kind) {
      case "focus":
        break;
      case "pause":
        work = Math.round(beat.seconds * fps);
        break;
      case "editor.open":
        segment.colors = await highlight(beat.file, beat.content);
        work = TIMING.openTab;
        break;
      case "editor.edit": {
        const plan = planTyping(beat.before, beat.after, { fps, ...TIMING.typing });
        segment.typing = {
          plan,
          before: await highlight(beat.file, beat.before),
          after: await highlight(beat.file, beat.after),
        };
        work = TIMING.editLeadIn + plan.frames + TIMING.editHold;
        break;
      }
      case "terminal":
        work = Math.max(1, Math.round((beat.end - beat.start) * fps));
        break;
      case "browser":
        work = TIMING.urlPaste + TIMING.pageLoad + TIMING.browserHold;
        break;
    }
    segment.duration = switchFrames + work;
    segments.push(segment);
    frame += segment.duration;
    app = next;
  }
  const initialColors: Record<string, Colors> = {};
  for (const tab of capture.editor.tabs) {
    initialColors[tab.file] = await highlight(tab.file, tab.content);
  }
  return { segments, initialColors, durationInFrames: Math.max(1, frame) };
};

/** The segment playing at `frame` (the last one once the scene has ended). */
export const segmentAt = (segments: Segment[], frame: number): Segment | undefined => {
  let found: Segment | undefined;
  for (const segment of segments) {
    if (segment.from <= frame) found = segment;
    else break;
  }
  return found;
};
