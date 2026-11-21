import { useEffect, useRef, type ReactNode } from "react";
import { highlightTS } from "../marketing/highlightTS";
import { useSpinner } from "./_terminal";

/*
 * The three steps of the full-picture animation that run on your machine,
 * before the pull request. An agent specifies a withdrawal as a story and
 * writes the logic that passes it. The proof then finds the sequence nobody
 * wrote a story for, and the fix keeps that sequence as a story. Last, the
 * same behavior is tested on emulated services and against the real cloud.
 *
 * Left: the editor. Right: the agent's transcript. Like the CI steps,
 * every frame is derived from ms elapsed in the step.
 */

export type LocalStepId = "specify" | "prove" | "local";

type Span = readonly [number, number];

// ---------- Specify: write the story, then the logic that passes it ----------
const T_PROMPT_DONE = 900;
const T_S_EDIT1 = 1100;
const T_S_STORY: Span = [1250, 3700]; // typing the story
const T_S_EDIT2 = 4300;
const T_S_A: Span = [4450, 5250]; // typing the command's signature
const T_S_B: Span = [5300, 6100]; // typing the event it records
const T_S_RUN = 6300;
const T_S_OK = 6700;
export const SPECIFY_MS = 8300;

// ---------- Prove: a rule breaks, the fix keeps the case as a story ----------
const T_P_RUN1 = 300;
const T_P_ERROR = 900;
const T_P_EDIT1 = 2900;
const T_P_C1: Span = [3050, 3550]; // typing the balance check
const T_P_C2: Span = [3600, 4050]; // typing the rejection
const T_P_EDIT2 = 4600;
const T_P_STORY: Span = [4750, 6500]; // typing the overdraft story
const T_P_RUN2 = 6700;
const T_P_OK = 7100;
export const PROVE_MS = 8900;

// ---------- Iterate locally: emulated test, then the real cloud ----------
// The live run replays the preview benchmark's measured phases
// (examples/cloudflare-preview-benchmark): deploy 13.35s, destroy 4.76s.
// It plays at LIVE_SPEED× so the step stays short, and says so.
export const LIVE_SPEED = 2;
const T_RUN1 = 300;
const T_EMU_UP = 1500;
const T_EMU_TEST = [1500, 1900] as const;
const T_RUN2 = 2700;
const T_DEPLOY = [2900, 2900 + 13350 / LIVE_SPEED] as const;
const T_LIVE_TEST = [T_DEPLOY[1], T_DEPLOY[1] + 700] as const;
const T_DESTROY = [T_LIVE_TEST[1], T_LIVE_TEST[1] + 4760 / LIVE_SPEED] as const;
const T_LIVE_DONE = T_DESTROY[1] + 150;
const T_PUSH = T_LIVE_DONE + 1100;
export const LOCAL_MS = T_PUSH + 1500;

const GREEN = "var(--alc-accent-bright)";
const RED = "var(--alc-danger)";

const PROMPT = "let customers withdraw money";
const AGGREGATE = "src/Account.aggregate.ts";
const STORIES = "test/Account.story.test.ts";
const LINE_A = "    WithdrawMoney: (account, { amount }) =>";
const LINE_B = "[new MoneyWithdrawn({ amount })],";
const LINE_C1 = "      amount > account.balance";
const LINE_C2 = "        ? new InsufficientFunds()";
const RULE = "Account.NeverOverdrawn";
const STORY_1 = "a withdrawal is recorded";
const STORY_2 = "an overdraft is rejected";
const LIVE_TEST = `${STORY_2} over HTTP`;
// The shortest sequence that breaks the rule, written as a story.
const COUNTEREXAMPLE = [
  "given  MoneyDeposited 50",
  "when   WithdrawMoney 80",
  "then   balance is -30",
];

const STORY_1_SRC = [
  `it.effect("${STORY_1}", () =>`,
  "  story(",
  "    Story.given(account, new MoneyDeposited({ amount: 50 })),",
  "    Story.when(account, new WithdrawMoney({ amount: 30 })),",
  "    Story.then(account, new MoneyWithdrawn({ amount: 30 })),",
  "  ),",
  ");",
];
const STORY_2_SRC = [
  `it.effect("${STORY_2}", () =>`,
  "  story(",
  "    Story.given(account, new MoneyDeposited({ amount: 50 })),",
  "    Story.when(account, new WithdrawMoney({ amount: 80 })),",
  "    Story.rejected(new InsufficientFunds()),",
  "  ),",
  ");",
];

const TEST_FILE = [
  "const { test, beforeAll, afterAll, deploy, destroy } = Test.make({",
  "  providers: Cloudflare.providers(),",
  "  dev: !!process.env.LOCAL, // emulated or real cloud",
  "});",
  "",
  "const stack = beforeAll(deploy(Stack));",
  "afterAll(destroy(Stack));",
  "",
  `test("${LIVE_TEST}", Effect.gen(function* () {`,
  "  const { url } = yield* stack;",
  '  const res = yield* withdraw(url, { account: "sam", amount: 80 });',
  "  expect(res.status).toBe(409);",
  "}));",
];

const typed = (text: string, [a, b]: Span, t: number) =>
  text.slice(0, Math.round(Math.min(1, Math.max(0, (t - a) / (b - a))) * text.length));
const typing = ([a, b]: Span, t: number) => t >= a && t < b;
/** Live seconds, scaled back up to real time. */
const liveSecs = (t: number, from: number) =>
  `${((Math.max(0, t - from) * LIVE_SPEED) / 1000).toFixed(1)}s`;

type CodeLine = {
  text: string;
  added?: boolean;
  caret?: boolean;
  error?: boolean;
  lit?: boolean;
};

/** A block typed line by line over `span`; the caret sits on the last line. */
function typedBlock(src: string[], span: Span, t: number): CodeLine[] {
  if (t < span[0]) return [];
  const total = src.reduce((n, l) => n + l.length, 0);
  let left = Math.round(Math.min(1, (t - span[0]) / (span[1] - span[0])) * total);
  const out: CodeLine[] = [];
  for (const line of src) {
    out.push({ text: line.slice(0, left), added: true });
    if (left <= line.length) break;
    left -= line.length;
  }
  if (typing(span, t)) out[out.length - 1]!.caret = true;
  return out;
}

function Chrome({
  title,
  badge,
  children,
}: {
  title: ReactNode;
  badge?: { text: string; tone: "green" | "red" | "sky" };
  children: ReactNode;
}) {
  return (
    <div className="prf-win">
      <div className="prf-win__bar">
        <span className="prf-dot" style={{ background: "var(--alc-dot-red)" }} />
        <span className="prf-dot" style={{ background: "var(--alc-dot-yellow)" }} />
        <span className="prf-dot" style={{ background: "var(--alc-dot-green)" }} />
        <span className="prf-win__title">{title}</span>
        {badge && <span className={`prf-badge prf-badge--${badge.tone}`}>{badge.text}</span>}
      </div>
      <div className="prf-win__body">{children}</div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Left: the editor                                                    */
/* ------------------------------------------------------------------ */

type File = "stories" | "aggregate" | "live";

/** Which file the editor shows: it follows the agent's latest edit. */
function fileAt(id: LocalStepId, t: number): File {
  if (id === "local") return "live";
  if (id === "specify") return t >= T_S_EDIT2 ? "aggregate" : "stories";
  return t >= T_P_EDIT2 ? "stories" : "aggregate";
}

function storyLines(id: LocalStepId, t: number): CodeLine[] {
  if (id === "specify") {
    const lines = typedBlock(STORY_1_SRC, T_S_STORY, t);
    return lines.length ? lines : [{ text: "", caret: true }];
  }
  return [
    ...STORY_1_SRC.map((text) => ({ text })),
    { text: "" },
    ...typedBlock(STORY_2_SRC, T_P_STORY, t),
  ];
}

function modelLines(id: LocalStepId, t: number): CodeLine[] {
  const proving = id === "prove";
  const error = proving && t >= T_P_ERROR && t < T_P_OK && t < T_P_EDIT2;
  const fixing = proving && t >= T_P_C1[0];
  const lines: CodeLine[] = [
    { text: 'export class Account extends Domain.Aggregate("Account", {' },
    { text: "  decide: {" },
    {
      text: proving ? LINE_A : typed(LINE_A, T_S_A, t),
      added: !proving,
      caret: !proving && (t < T_S_A[0] || typing(T_S_A, t)),
    },
  ];
  if (fixing)
    lines.push({
      text: typed(LINE_C1, T_P_C1, t),
      added: true,
      caret: typing(T_P_C1, t),
    });
  if (proving && t >= T_P_C2[0])
    lines.push({
      text: typed(LINE_C2, T_P_C2, t),
      added: true,
      caret: typing(T_P_C2, t),
    });
  if (proving || t >= T_S_B[0])
    lines.push({
      text: (fixing ? "        : " : "      ") + (proving ? LINE_B : typed(LINE_B, T_S_B, t)),
      added: !proving || fixing,
      caret: !proving && typing(T_S_B, t),
    });
  lines.push(
    { text: "  }," },
    { text: "  invariants: {" },
    { text: "    NeverOverdrawn: ({ balance }) => balance >= 0,", error },
    { text: "  }," },
    { text: "}) {}" },
  );
  return lines;
}

function testLines(t: number): CodeLine[] {
  // The `dev:` line decides where the run goes; the hooks are what the live
  // run adds: a stage of its own, deployed first and destroyed after.
  const emulated = t >= T_RUN1 && t < T_RUN2;
  const live = t >= T_RUN2 && t < T_LIVE_DONE;
  return TEST_FILE.map((text, i) => ({
    text,
    lit: (emulated && i === 2) || (live && (i === 5 || i === 6)),
  }));
}

const FILES: Record<File, { path: string; tab: string }> = {
  stories: { path: STORIES, tab: "Account.story.test.ts" },
  aggregate: { path: AGGREGATE, tab: "Account.aggregate.ts" },
  live: { path: "test/Bank.test.ts", tab: "Bank.test.ts" },
};

export function EditorPane({ id, t }: { id: LocalStepId; t: number }) {
  const file = fileAt(id, t);
  const lines =
    file === "stories"
      ? storyLines(id, t)
      : file === "aggregate"
        ? modelLines(id, t)
        : testLines(t);
  const errorAt = lines.findIndex((l) => l.error);
  return (
    <Chrome title={<>bank — {FILES[file].path}</>}>
      <div className="prf-edtabs" aria-hidden>
        {(Object.keys(FILES) as File[]).map((f) => (
          <span key={f} className={`prf-edtab ${f === file ? "is-active" : ""}`}>
            {FILES[f].tab}
          </span>
        ))}
      </div>
      <div className="prf-code">
        {lines.map((l, i) => (
          <div key={`${file}-${i}`}>
            <div className={`prf-code__line ${l.added ? "is-added" : ""} ${l.lit ? "is-lit" : ""}`}>
              <span className="prf-code__n">{i + 1}</span>
              <span
                className={`prf-code__t ${l.error ? "is-error" : ""}`}
                dangerouslySetInnerHTML={{
                  __html: highlightTS(l.text) || "&nbsp;",
                }}
              />
              {l.caret && <span className="prf-caret" />}
            </div>
            {i === errorAt && (
              <div className="prf-diag prf-enter">
                <span style={{ color: RED }}>✗</span> a customer can overdraw: deposit 50, withdraw
                80
              </div>
            )}
          </div>
        ))}
      </div>
    </Chrome>
  );
}

/* ------------------------------------------------------------------ */
/* Right: the agent                                                    */
/* ------------------------------------------------------------------ */

function Action({
  title,
  detail,
  children,
}: {
  title: ReactNode;
  detail?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="prf-act prf-enter">
      <div className="prf-act__head">
        <span className="prf-act__dot">●</span>
        <span className="prf-strong">{title}</span>
        {detail && <span className="prf-muted"> {detail}</span>}
      </div>
      {children && <div className="prf-act__out">{children}</div>}
    </div>
  );
}

function Row({
  done,
  spin,
  tone = GREEN,
  children,
}: {
  done: boolean;
  spin: string;
  tone?: string;
  children: ReactNode;
}) {
  return (
    <div className="prf-act__row">
      <span className="prf-log__icon" style={{ color: tone }}>
        {done ? "✓" : spin}
      </span>
      {children}
    </div>
  );
}

export function AgentPane({ id, t, paused }: { id: LocalStepId; t: number; paused: boolean }) {
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  });
  const busy =
    id === "specify"
      ? t >= T_S_RUN && t < T_S_OK
      : id === "prove"
        ? (t >= T_P_RUN1 && t < T_P_ERROR) || (t >= T_P_RUN2 && t < T_P_OK)
        : (t >= T_RUN1 && t < T_EMU_TEST[1]) || (t >= T_RUN2 && t < T_DESTROY[1]);
  const spin = useSpinner(busy && !paused);

  const prompt =
    id === "specify"
      ? PROMPT.slice(0, Math.round(Math.min(1, t / T_PROMPT_DONE) * PROMPT.length))
      : PROMPT;

  const items: ReactNode[] = [
    <div className="prf-act__prompt" key="prompt">
      <span className="prf-muted">›</span> {prompt}
      {id === "specify" && t < T_PROMPT_DONE && <span className="prf-caret" />}
    </div>,
  ];

  if (id === "specify") {
    if (t >= T_S_EDIT1)
      items.push(<Action key="e1" title="Edit" detail={`${STORIES} · the story first`} />);
    if (t >= T_S_EDIT2)
      items.push(<Action key="e2" title="Edit" detail={`${AGGREGATE} · +2 lines`} />);
    if (t >= T_S_RUN)
      items.push(
        <Action key="r" title="Run" detail="pnpm test Account.story">
          <Row done={t >= T_S_OK} spin={spin}>
            {STORY_1}
          </Row>
          {t >= T_S_OK && (
            <div className="prf-act__row">
              <span style={{ color: GREEN }}>13 stories pass</span>
              <span className="prf-muted"> · in memory, nothing deployed</span>
            </div>
          )}
        </Action>,
      );
  } else if (id === "prove") {
    items.push(<Action key="done" title="Edit" detail={`${AGGREGATE} · 13 stories pass`} />);
    if (t >= T_P_RUN1)
      items.push(
        <Action key="r1" title="Run" detail="pnpm test">
          {t < T_P_ERROR ? (
            <Row done={false} spin={spin}>
              proving 6 rules
            </Row>
          ) : (
            <>
              <div className="prf-act__row">
                <span className="prf-log__icon" style={{ color: RED }}>
                  ✗
                </span>
                <span style={{ color: RED }}>1 rule broken</span>
                <span className="prf-muted"> · {RULE}</span>
              </div>
              <div className="prf-act__msg prf-act__story">
                {COUNTEREXAMPLE.map((l) => (
                  <div key={l}>{l}</div>
                ))}
              </div>
            </>
          )}
        </Action>,
      );
    if (t >= T_P_EDIT1)
      items.push(<Action key="e1" title="Edit" detail={`${AGGREGATE} · reject an overdraft`} />);
    if (t >= T_P_EDIT2)
      items.push(<Action key="e2" title="Edit" detail={`${STORIES} · keep the case as a story`} />);
    if (t >= T_P_RUN2)
      items.push(
        <Action key="r2" title="Run" detail="pnpm test">
          <Row done={t >= T_P_OK} spin={spin}>
            {t >= T_P_OK ? "14 stories pass" : "proving 6 rules"}
          </Row>
          {t >= T_P_OK && (
            <Row done spin={spin}>
              6 rules proved and checked
            </Row>
          )}
        </Action>,
      );
  } else {
    items.push(
      <Action key="done-edit" title="Run" detail="pnpm test · 14 stories pass, 6 rules proved" />,
    );
    if (t >= T_RUN1)
      items.push(
        <Action key="r1" title="Run" detail="LOCAL=1 pnpm test">
          <Row done={t >= T_EMU_UP} spin={spin}>
            {t >= T_EMU_UP ? "stack running on emulated services" : "starting emulated services"}
          </Row>
          {t >= T_EMU_TEST[0] && (
            <Row done={t >= T_EMU_TEST[1]} spin={spin}>
              {LIVE_TEST}
            </Row>
          )}
          {t >= T_EMU_TEST[1] && (
            <div className="prf-act__row">
              <span style={{ color: GREEN }}>1 pass</span>
              <span className="prf-muted"> · 0 fail · nothing deployed</span>
            </div>
          )}
        </Action>,
      );
    if (t >= T_RUN2)
      items.push(
        <Action key="r2" title="Run" detail="pnpm test">
          {t >= T_DEPLOY[0] && (
            <Row done={t >= T_DEPLOY[1]} spin={spin}>
              {t >= T_DEPLOY[1] ? "deployed" : "deploying"} 3 resources
              <span className="prf-muted">
                {" · "}
                {liveSecs(Math.min(t, T_DEPLOY[1]), T_DEPLOY[0])}
              </span>
            </Row>
          )}
          {t >= T_LIVE_TEST[0] && (
            <Row done={t >= T_LIVE_TEST[1]} spin={spin}>
              {LIVE_TEST}
            </Row>
          )}
          {t >= T_DESTROY[0] && (
            <Row done={t >= T_DESTROY[1]} spin={spin} tone={RED}>
              {t >= T_DESTROY[1] ? "destroyed" : "destroying"} 3 resources
              <span className="prf-muted">
                {" · "}
                {liveSecs(Math.min(t, T_DESTROY[1]), T_DESTROY[0])}
              </span>
            </Row>
          )}
          {t < T_LIVE_DONE ? (
            <div className="prf-act__row prf-muted">
              {"  "}(played at {LIVE_SPEED}× speed)
            </div>
          ) : (
            <div className="prf-act__row">
              <span style={{ color: GREEN }}>1 pass</span>
              <span className="prf-muted"> · 0 fail · real cloud</span>
            </div>
          )}
        </Action>,
      );
    if (t >= T_PUSH)
      items.push(
        <Action key="push" title="Push" detail="feature/withdrawals · open a pull request" />,
      );
  }

  return (
    <Chrome
      title="agent · bank"
      badge={
        id === "specify"
          ? { text: "STORY", tone: "green" }
          : id === "prove"
            ? { text: "PROVE", tone: "sky" }
            : { text: "TEST", tone: "green" }
      }
    >
      <div className="prf-agent" ref={listRef}>
        {items}
      </div>
    </Chrome>
  );
}
