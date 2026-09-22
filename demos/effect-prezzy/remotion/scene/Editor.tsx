import type { ReactNode } from "react";
import { TITLE_BAR, WINDOW, type SceneCapture } from "../../shared/types.ts";
import { mono, sans } from "../fonts.ts";
import { vscode } from "../theme.ts";
import { Window } from "./Desktop.tsx";
import { languageLabel } from "./highlight.ts";
import { TIMING, type SceneSchedule } from "./schedule.ts";
import { staticDocument, typedAt, type Glyph, type TypedDocument } from "./typing.ts";

const CODE = { fontSize: 21, lineHeight: 32, charWidth: 21 * 0.6 } as const;
const UI = 15;
const ACTIVITY_BAR = 52;
const SIDEBAR = 270;
const TABS = 42;
const BREADCRUMBS = 28;
const STATUS = 28;
const GUTTER = 76;

interface EditorState {
  files: string[];
  tabs: string[];
  active: string | undefined;
  document: TypedDocument | undefined;
  /** True while characters are landing, so the cursor stays solid. */
  typing: boolean;
}

const editorState = (
  capture: SceneCapture,
  plan: SceneSchedule,
  frame: number,
): EditorState => {
  const files = new Set(capture.files);
  const tabs = capture.editor.tabs.map((t) => t.file);
  let active = capture.editor.active;
  const initial = capture.editor.tabs.find((t) => t.file === active);
  let document =
    initial && active ? staticDocument(initial.content, plan.initialColors[active] ?? []) : undefined;
  let typing = false;
  for (const segment of plan.segments) {
    if (segment.from > frame) break;
    const { beat } = segment;
    if (beat.kind !== "editor.open" && beat.kind !== "editor.edit") continue;
    if (!tabs.includes(beat.file)) tabs.push(beat.file);
    active = beat.file;
    files.add(beat.file);
    if (beat.kind === "editor.open") {
      document = staticDocument(beat.content, segment.colors ?? []);
      typing = false;
    } else if (segment.typing) {
      const local = frame - segment.from - segment.switchFrames - TIMING.editLeadIn;
      const { plan: typingPlan, before, after } = segment.typing;
      document = typedAt(typingPlan, local, before, after);
      typing = local >= 0 && local <= typingPlan.frames;
    }
  }
  return { files: [...files].sort(), tabs, active, document, typing };
};

interface TreeNode {
  name: string;
  path: string;
  children: TreeNode[];
}

const buildTree = (files: string[]): TreeNode[] => {
  const root: TreeNode = { name: "", path: "", children: [] };
  for (const file of files) {
    let node = root;
    const parts = file.split("/");
    parts.forEach((name, i) => {
      const nodePath = parts.slice(0, i + 1).join("/");
      let child = node.children.find((c) => c.name === name);
      if (!child) {
        child = { name, path: nodePath, children: [] };
        node.children.push(child);
      }
      node = child;
    });
  }
  const sort = (nodes: TreeNode[]): TreeNode[] =>
    nodes
      .sort((a, b) =>
        a.children.length > 0 === b.children.length > 0
          ? a.name.localeCompare(b.name)
          : a.children.length > 0
            ? -1
            : 1,
      )
      .map((n) => ({ ...n, children: sort(n.children) }));
  return sort(root.children);
};

const FileIcon = ({ name }: { name: string }) => {
  const ext = name.split(".").pop();
  const [label, color] =
    ext === "ts"
      ? ["TS", "#3178c6"]
      : ext === "tsx"
        ? ["⚛", "#4fc1ff"]
        : ext === "json"
          ? ["{}", "#cbcb41"]
          : ext === "css"
            ? ["#", "#56b6f7"]
            : ext === "html"
              ? ["<>", "#e37933"]
              : ["≡", "#9d9d9d"];
  return (
    <span
      style={{
        width: 22,
        display: "inline-block",
        textAlign: "center",
        color,
        fontFamily: mono,
        fontSize: label.length > 1 ? 11 : 14,
        fontWeight: 700,
      }}
    >
      {label}
    </span>
  );
};

const Chevron = ({ open = true }: { open?: boolean }) => (
  <svg width="16" height="16" viewBox="0 0 16 16" style={{ flex: "none" }}>
    <path
      d={open ? "M4 6 L8 10 L12 6" : "M6 4 L10 8 L6 12"}
      stroke={vscode.fgMuted}
      strokeWidth="1.4"
      fill="none"
    />
  </svg>
);

const Tree = ({ nodes, depth, active }: { nodes: TreeNode[]; depth: number; active?: string }) => (
  <>
    {nodes.map((node) => (
      <div key={node.path}>
        <div
          style={{
            height: 26,
            display: "flex",
            alignItems: "center",
            gap: 4,
            paddingLeft: 12 + depth * 14,
            background: node.path === active ? vscode.listActive : undefined,
            outline: node.path === active ? `1px solid ${vscode.accent}` : undefined,
            outlineOffset: -1,
            color: vscode.fg,
          }}
        >
          {node.children.length > 0 ? <Chevron /> : <span style={{ width: 16 }} />}
          {node.children.length > 0 ? null : <FileIcon name={node.name} />}
          <span>{node.name}</span>
        </div>
        {node.children.length > 0 ? (
          <Tree nodes={node.children} depth={depth + 1} active={active} />
        ) : null}
      </div>
    ))}
  </>
);

const ActivityIcon = ({ children, active }: { children: ReactNode; active?: boolean }) => (
  <div
    style={{
      height: 56,
      display: "grid",
      placeItems: "center",
      borderLeft: `2px solid ${active ? vscode.fg : "transparent"}`,
      opacity: active ? 1 : 0.5,
    }}
  >
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke={vscode.fg} strokeWidth="1.5">
      {children}
    </svg>
  </div>
);

const ActivityBar = () => (
  <div style={{ width: ACTIVITY_BAR, background: vscode.chromeBg, borderRight: `1px solid ${vscode.border}` }}>
    <ActivityIcon active>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
    </ActivityIcon>
    <ActivityIcon>
      <circle cx="11" cy="11" r="6" />
      <path d="M20 20l-4.5-4.5" />
    </ActivityIcon>
    <ActivityIcon>
      <circle cx="6" cy="6" r="2" />
      <circle cx="6" cy="18" r="2" />
      <circle cx="18" cy="8" r="2" />
      <path d="M6 8v8M18 10c0 4-6 3-11 6" />
    </ActivityIcon>
    <ActivityIcon>
      <rect x="4" y="4" width="7" height="7" />
      <rect x="13" y="4" width="7" height="7" />
      <rect x="4" y="13" width="7" height="7" />
      <rect x="13" y="13" width="7" height="7" />
    </ActivityIcon>
  </div>
);

const lines = (glyphs: Glyph[]): Glyph[][] => {
  const out: Glyph[][] = [[]];
  for (const glyph of glyphs) {
    if (glyph.char === "\n") out.push([]);
    else out[out.length - 1]!.push(glyph);
  }
  return out;
};

/** Merge neighbouring glyphs that share colour and selection into spans. */
const Line = ({ glyphs }: { glyphs: Glyph[] }) => {
  const spans: Glyph[] = [];
  for (const glyph of glyphs) {
    const last = spans[spans.length - 1];
    if (last && last.color === glyph.color && last.selected === glyph.selected) {
      last.char += glyph.char;
    } else {
      spans.push({ ...glyph });
    }
  }
  return (
    <>
      {spans.map((span, i) => (
        <span
          key={i}
          style={{
            color: span.color || vscode.fg,
            background: span.selected ? vscode.selection : undefined,
          }}
        >
          {span.char}
        </span>
      ))}
    </>
  );
};

const Code = ({
  document,
  height,
  cursorVisible,
}: {
  document: TypedDocument;
  height: number;
  cursorVisible: boolean;
}) => {
  const all = lines(document.glyphs);
  // Cursor line/column from the glyph index.
  let cursorLine = -1;
  let cursorColumn = 0;
  if (document.cursor >= 0) {
    cursorLine = 0;
    for (let i = 0; i < document.cursor && i < document.glyphs.length; i++) {
      if (document.glyphs[i]!.char === "\n") {
        cursorLine++;
        cursorColumn = 0;
      } else {
        cursorColumn++;
      }
    }
  }
  const visible = Math.floor(height / CODE.lineHeight) - 1;
  const scroll =
    cursorLine < 0
      ? 0
      : Math.max(0, Math.min(cursorLine - (visible - 6), all.length - visible));
  const shown = all.slice(scroll, scroll + visible + 1);
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        fontFamily: mono,
        fontSize: CODE.fontSize,
        lineHeight: `${CODE.lineHeight}px`,
        whiteSpace: "pre",
        paddingTop: 6,
      }}
    >
      {shown.map((glyphs, i) => {
        const number = scroll + i;
        const current = number === cursorLine;
        return (
          <div
            key={number}
            style={{
              height: CODE.lineHeight,
              display: "flex",
              position: "relative",
              background: current ? vscode.activeLine : undefined,
              outline: current ? `1px solid ${vscode.border}` : undefined,
            }}
          >
            <span
              style={{
                width: GUTTER,
                paddingRight: 24,
                textAlign: "right",
                color: current ? vscode.lineNumberActive : vscode.lineNumber,
                flex: "none",
              }}
            >
              {number + 1}
            </span>
            <span>
              <Line glyphs={glyphs} />
            </span>
            {current && cursorVisible ? (
              <span
                style={{
                  position: "absolute",
                  left: GUTTER + cursorColumn * CODE.charWidth,
                  top: 3,
                  width: 2,
                  height: CODE.lineHeight - 6,
                  background: vscode.cursor,
                }}
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
};

export const Editor = ({
  capture,
  plan,
  frame,
}: {
  capture: SceneCapture;
  plan: SceneSchedule;
  frame: number;
}) => {
  const state = editorState(capture, plan, frame);
  const cursorVisible = state.typing || frame % 32 < 18;
  const title = state.active ? `${state.active.split("/").pop()} — ${capture.project}` : capture.project;
  const codeHeight = WINDOW.height - TITLE_BAR - TABS - BREADCRUMBS - STATUS;
  return (
    <Window title={title} background={vscode.editorBg}>
      <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", fontFamily: sans, fontSize: UI }}>
        <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
          <ActivityBar />
          <div style={{ width: SIDEBAR, background: vscode.chromeBg, borderRight: `1px solid ${vscode.border}`, color: vscode.fg }}>
            <div style={{ height: 40, display: "flex", alignItems: "center", padding: "0 20px", fontSize: 13, letterSpacing: 0.6, color: vscode.fgMuted }}>
              EXPLORER
            </div>
            <div style={{ height: 28, display: "flex", alignItems: "center", gap: 4, padding: "0 6px", fontWeight: 700, fontSize: 13, letterSpacing: 0.4 }}>
              <Chevron />
              {capture.project.toUpperCase()}
            </div>
            <Tree nodes={buildTree(state.files)} depth={0} active={state.active} />
          </div>
          <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
            <div style={{ height: TABS, display: "flex", background: vscode.chromeBg, borderBottom: `1px solid ${vscode.border}` }}>
              {state.tabs.map((tab) => {
                const active = tab === state.active;
                return (
                  <div
                    key={tab}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      padding: "0 18px 0 12px",
                      background: active ? vscode.editorBg : vscode.chromeBg,
                      borderTop: `2px solid ${active ? vscode.tabActiveBorder : "transparent"}`,
                      borderRight: `1px solid ${vscode.border}`,
                      color: active ? "#ffffff" : vscode.fgMuted,
                      marginBottom: active ? -1 : 0,
                    }}
                  >
                    <FileIcon name={tab} />
                    {tab.split("/").pop()}
                  </div>
                );
              })}
            </div>
            <div style={{ height: BREADCRUMBS, display: "flex", alignItems: "center", gap: 8, padding: "0 20px", color: vscode.fgMuted, fontSize: 14 }}>
              {(state.active ?? "").split("/").map((part, i, all) => (
                <span key={i} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  {i === all.length - 1 ? <FileIcon name={part} /> : null}
                  {part}
                  {i < all.length - 1 ? <span>›</span> : null}
                </span>
              ))}
            </div>
            <div style={{ flex: 1, position: "relative", overflow: "hidden" }}>
              {state.document ? (
                <Code document={state.document} height={codeHeight} cursorVisible={cursorVisible} />
              ) : null}
            </div>
          </div>
        </div>
        <div
          style={{
            height: STATUS,
            display: "flex",
            alignItems: "center",
            gap: 22,
            padding: "0 14px",
            background: vscode.chromeBg,
            borderTop: `1px solid ${vscode.border}`,
            color: vscode.fgMuted,
            fontSize: 13,
          }}
        >
          <span>⎇ main</span>
          <span>⊗ 0 ⚠ 0</span>
          <span style={{ marginLeft: "auto" }}>Spaces: 2</span>
          <span>UTF-8</span>
          <span>{state.active ? languageLabel(state.active) : ""}</span>
        </div>
      </div>
    </Window>
  );
};
