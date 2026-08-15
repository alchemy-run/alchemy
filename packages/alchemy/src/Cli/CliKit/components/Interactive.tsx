/** @jsxImportSource react */
import { useInput, useStdout } from "ink";
import { type JSX, useEffect, useRef, useState } from "react";
import type { Choice, CycleChoice } from "../types.ts";
import { theme } from "../theme.ts";
import { copyToClipboard, truncate } from "../terminal.ts";
import { useFocus } from "./Application.tsx";
import { useCliEnvironment, useGlyphs, useKeyGlyphs } from "./Environment.tsx";
import { KeyBar, Spinner } from "./Feedback.tsx";
import { Box } from "./Layout.tsx";
import { Link, Text } from "./Typography.tsx";

export interface TerminalKey {
  readonly up: boolean;
  readonly down: boolean;
  readonly left: boolean;
  readonly right: boolean;
  readonly home: boolean;
  readonly end: boolean;
  readonly pageUp: boolean;
  readonly pageDown: boolean;
  readonly enter: boolean;
  readonly escape: boolean;
  readonly backspace: boolean;
  readonly delete: boolean;
  readonly tab: boolean;
  readonly shift: boolean;
  readonly ctrl: boolean;
  readonly meta: boolean;
}

/** Backend facade for custom screens; callers never need to import Ink. */
export const useTerminalInput = (
  handler: (input: string, key: TerminalKey) => void,
  options?: { readonly active?: boolean },
) => {
  const focused = useFocus();
  return useInput(
    (input, key) =>
      handler(input, {
        up: key.upArrow,
        down: key.downArrow,
        left: key.leftArrow,
        right: key.rightArrow,
        home: key.home,
        end: key.end,
        pageUp: key.pageUp,
        pageDown: key.pageDown,
        enter: key.return,
        escape: key.escape,
        backspace: key.backspace,
        delete: key.delete,
        tab: key.tab,
        shift: key.shift,
        ctrl: key.ctrl,
        meta: key.meta,
      }),
    { isActive: options?.active ?? focused },
  );
};

export const useTerminalSize = () => {
  const { columns, rows } = useCliEnvironment();
  return { columns, rows };
};

export const useListNavigation = (length: number, initialIndex = 0) => {
  const [cursor, setCursor] = useState(initialIndex);
  const clamped = Math.max(0, Math.min(cursor, Math.max(0, length - 1)));
  const move = (delta: number) =>
    setCursor((current) =>
      length === 0 ? 0 : (current + delta + length) % length,
    );
  return { cursor: clamped, move, setCursor } as const;
};

/** Step `delta` rows from `cursor`, wrapping and skipping disabled rows. */
export const moveSkippingDisabled = (
  disabled: ReadonlyArray<boolean>,
  cursor: number,
  delta: number,
): number => {
  const length = disabled.length;
  if (length === 0) return 0;
  for (let offset = 1; offset <= length; offset++) {
    const next = (((cursor + delta * offset) % length) + length) % length;
    if (!disabled[next]) return next;
  }
  return cursor;
};

/**
 * Jump to `target` (clamped, no wrap), settling on the nearest enabled row in
 * the jump direction and falling back to the other direction. Used for
 * Home/End and PageUp/PageDown in list prompts.
 */
export const jumpSkippingDisabled = (
  disabled: ReadonlyArray<boolean>,
  cursor: number,
  target: number,
): number => {
  const clamped = Math.max(0, Math.min(disabled.length - 1, target));
  if (!disabled[clamped]) return clamped;
  const direction = clamped >= cursor ? 1 : -1;
  for (
    let next = clamped + direction;
    next >= 0 && next < disabled.length;
    next += direction
  ) {
    if (!disabled[next]) return next;
  }
  for (
    let next = clamped - direction;
    next >= 0 && next < disabled.length;
    next -= direction
  ) {
    if (!disabled[next]) return next;
  }
  return cursor;
};

export interface MenuProps<Value> {
  readonly choices: ReadonlyArray<Choice<Value>>;
  readonly cursor: number;
  readonly selected?: ReadonlySet<number>;
  readonly visibleCount?: number;
  readonly empty?: string;
  readonly descriptionPlacement?: "below" | "inline";
}

/** Pure menu presentation used by select prompts and custom applications. */
export const Menu = <Value,>({
  choices,
  cursor,
  selected,
  visibleCount = 12,
  empty = "No choices.",
  descriptionPlacement = "below",
}: MenuProps<Value>): JSX.Element => {
  const glyphs = useGlyphs();
  if (choices.length === 0) return <Text tone="muted">{empty}</Text>;
  const count = Math.max(1, visibleCount);
  const start = Math.max(
    0,
    Math.min(cursor - Math.floor(count / 2), choices.length - count),
  );
  const end = Math.min(choices.length, start + count);
  const stickyIndex =
    start === 0
      ? -1
      : choices.findLastIndex(
          (choice, index) => index < start && choice.sticky,
        );
  const visible = [
    ...(stickyIndex === -1 ? [] : [stickyIndex]),
    ...Array.from({ length: end - start }, (_, offset) => start + offset),
  ];
  return (
    <Box flexDirection="column">
      {start > 0 ? (
        <Text tone="muted">
          {" "}
          {glyphs.overflowUp} {start} more
        </Text>
      ) : null}
      {visible.map((index) => {
        const choice = choices[index]!;
        const focused = index === cursor;
        const checked = selected?.has(index);
        const disabled =
          choice.disabled !== undefined && choice.disabled !== false;
        const previous = choices[index - 1];
        const showGroup =
          choice.group !== undefined &&
          (index === start || previous?.group !== choice.group);
        return (
          <Box key={index} flexDirection="column">
            {showGroup ? (
              <Text bold color={theme.color.info}>
                {choice.group}
              </Text>
            ) : null}
            <Box gap={1} paddingLeft={choice.indent ?? 0}>
              <Text color={focused ? theme.color.accentBright : undefined}>
                {focused ? glyphs.pointer : " "}
              </Text>
              <Text
                color={
                  checked
                    ? theme.color.success
                    : focused
                      ? theme.color.accentBright
                      : undefined
                }
                dimColor={disabled}
              >
                {selected === undefined
                  ? focused
                    ? glyphs.selected
                    : glyphs.unselected
                  : checked
                    ? glyphs.checked
                    : glyphs.unchecked}
              </Text>
              <Box
                flexDirection={
                  descriptionPlacement === "inline" ? "row" : "column"
                }
                flexGrow={1}
                gap={descriptionPlacement === "inline" ? 1 : 0}
              >
                <Text
                  bold={focused || choice.sticky}
                  color={choice.tone === "info" ? theme.color.info : undefined}
                  dimColor={disabled}
                >
                  {choice.label}
                </Text>
                {choice.description === undefined ? null : (
                  <Text tone="muted" wrap="truncate-end">
                    {descriptionPlacement === "inline" ? "— " : ""}
                    {choice.description}
                  </Text>
                )}
              </Box>
              {typeof choice.disabled === "string" ? (
                <Text tone="muted">{choice.disabled}</Text>
              ) : null}
            </Box>
          </Box>
        );
      })}
      {end < choices.length ? (
        <Text tone="muted">
          {" "}
          {glyphs.overflowDown} {choices.length - end} more
        </Text>
      ) : null}
    </Box>
  );
};

export interface TextFieldProps {
  readonly placeholder?: string;
  readonly initialValue?: string;
  readonly value?: string;
  readonly mask?: string;
  readonly onSubmit: (value: string) => void;
  readonly onChange?: (value: string) => void;
  readonly onCancel?: () => void;
  readonly active?: boolean;
}

const graphemeSegmenter = new Intl.Segmenter();

/**
 * Split into user-perceived characters so cursor movement and deletion never
 * land inside a surrogate pair or emoji cluster.
 */
const toGraphemes = (value: string): ReadonlyArray<string> =>
  Array.from(graphemeSegmenter.segment(value), (segment) => segment.segment);

/**
 * Ink has no bracketed-paste support, so a paste arrives as one multi-char
 * input chunk that may carry newlines, tabs or stray escape bytes. A
 * single-line field drops control characters instead of splicing them in.
 */
export const sanitizeTextInsert = (input: string): string =>
  // eslint-disable-next-line no-control-regex
  input.replace(/[\u0000-\u001f\u007f]/g, "");

/** Readline-style whitespace word boundary to the left of `cursor`. */
const wordBoundaryLeft = (
  chars: ReadonlyArray<string>,
  cursor: number,
): number => {
  let index = cursor;
  while (index > 0 && chars[index - 1] === " ") index--;
  while (index > 0 && chars[index - 1] !== " ") index--;
  return index;
};

/** Readline-style whitespace word boundary to the right of `cursor`. */
const wordBoundaryRight = (
  chars: ReadonlyArray<string>,
  cursor: number,
): number => {
  let index = cursor;
  while (index < chars.length && chars[index] === " ") index++;
  while (index < chars.length && chars[index] !== " ") index++;
  return index;
};

/**
 * Single-line editor with insertion, deletion, home/end, word-wise movement
 * and the common readline kill bindings (Ctrl+U/K/W, Alt+Backspace).
 */
export const TextField = ({
  placeholder,
  initialValue = "",
  value: controlledValue,
  mask,
  onSubmit,
  onChange,
  onCancel,
  active,
}: TextFieldProps) => {
  const focused = useFocus();
  const [internalValue, setInternalValue] = useState(initialValue);
  const value = controlledValue ?? internalValue;
  const chars = toGraphemes(value);
  const [cursor, setCursor] = useState(() => toGraphemes(initialValue).length);
  useEffect(() => {
    setCursor((current) => Math.min(current, toGraphemes(value).length));
  }, [value]);
  const update = (nextChars: ReadonlyArray<string>, nextCursor: number) => {
    const next = nextChars.join("");
    if (controlledValue === undefined) setInternalValue(next);
    setCursor(Math.max(0, Math.min(nextChars.length, nextCursor)));
    onChange?.(next);
  };
  useTerminalInput(
    (input, key) => {
      if (key.enter) onSubmit(value);
      else if (key.escape) onCancel?.();
      else if (key.left)
        setCursor(
          key.ctrl || key.meta
            ? wordBoundaryLeft(chars, cursor)
            : Math.max(0, cursor - 1),
        );
      else if (key.right)
        setCursor(
          key.ctrl || key.meta
            ? wordBoundaryRight(chars, cursor)
            : Math.min(chars.length, cursor + 1),
        );
      // Most terminals send DEL (0x7f) for Backspace. Ink exposes that as
      // `key.delete`, while Ctrl+H is exposed as `key.backspace` — both mean
      // "delete left" here; Alt+Backspace deletes the word to the left.
      else if ((key.backspace || key.delete) && cursor > 0) {
        const target = key.meta ? wordBoundaryLeft(chars, cursor) : cursor - 1;
        update([...chars.slice(0, target), ...chars.slice(cursor)], target);
      } else if (key.ctrl && input === "d" && cursor < chars.length)
        update([...chars.slice(0, cursor), ...chars.slice(cursor + 1)], cursor);
      else if (key.ctrl && input === "w" && cursor > 0) {
        const target = wordBoundaryLeft(chars, cursor);
        update([...chars.slice(0, target), ...chars.slice(cursor)], target);
      } else if (key.ctrl && input === "u") update(chars.slice(cursor), 0);
      else if (key.ctrl && input === "k")
        update(chars.slice(0, cursor), cursor);
      else if (key.home || (key.ctrl && input === "a")) setCursor(0);
      else if (key.end || (key.ctrl && input === "e")) setCursor(chars.length);
      else if (key.meta && input === "b")
        setCursor(wordBoundaryLeft(chars, cursor));
      else if (key.meta && input === "f")
        setCursor(wordBoundaryRight(chars, cursor));
      else if (!key.ctrl && !key.meta && !key.tab) {
        const inserted = toGraphemes(sanitizeTextInsert(input));
        if (inserted.length > 0) {
          update(
            [...chars.slice(0, cursor), ...inserted, ...chars.slice(cursor)],
            cursor + inserted.length,
          );
        }
      }
    },
    { active: active ?? focused },
  );
  const shownChars = mask === undefined ? chars : chars.map(() => mask);
  if (shownChars.length === 0) {
    return (
      <Text>
        <Text inverse> </Text>
        {placeholder === undefined ? null : (
          <Text tone="muted">{placeholder}</Text>
        )}
      </Text>
    );
  }
  return (
    <Text>
      {shownChars.slice(0, cursor).join("")}
      <Text inverse>{shownChars[cursor] ?? " "}</Text>
      {shownChars.slice(cursor + 1).join("")}
    </Text>
  );
};

export interface CycleListProps<State> {
  readonly choices: ReadonlyArray<CycleChoice<State>>;
  readonly cursor: number;
  readonly indices: ReadonlyArray<number>;
  readonly visibleCount?: number;
}

const stateColor = (
  variant: CycleChoice<unknown>["states"][number]["variant"],
) =>
  variant === undefined || variant === "neutral"
    ? undefined
    : theme.color[variant === "error" ? "danger" : variant];

export const CycleList = <State,>({
  choices,
  cursor,
  indices,
  visibleCount = 12,
}: CycleListProps<State>) => {
  const glyphs = useGlyphs();
  const count = Math.max(1, visibleCount);
  const start = Math.max(
    0,
    Math.min(cursor - Math.floor(count / 2), choices.length - count),
  );
  const end = Math.min(choices.length, start + count);
  return (
    <Box flexDirection="column">
      {start > 0 ? (
        <Text tone="muted">
          {" "}
          {glyphs.overflowUp} {start} more
        </Text>
      ) : null}
      {choices.slice(start, end).map((choice, offset) => {
        const index = start + offset;
        const state = choice.states[indices[index] ?? 0];
        const focused = index === cursor;
        const color = stateColor(state?.variant);
        return (
          <Box key={index} gap={1}>
            <Text color={focused ? theme.color.accentBright : undefined}>
              {focused ? glyphs.pointer : " "}
            </Text>
            <Text color={color} dimColor={color === undefined}>
              {state?.icon ?? glyphs.bullet}
            </Text>
            <Text
              bold={focused}
              color={focused ? theme.color.accentBright : undefined}
            >
              {choice.label}
            </Text>
            {state?.label === undefined ? null : (
              <Text color={color}>{state.label}</Text>
            )}
            {choice.description === undefined ? null : (
              <Text tone="muted">({choice.description})</Text>
            )}
          </Box>
        );
      })}
      {end < choices.length ? (
        <Text tone="muted">
          {" "}
          {glyphs.overflowDown} {choices.length - end} more
        </Text>
      ) : null}
    </Box>
  );
};

export const useCycleNavigation = (stateCounts: ReadonlyArray<number>) => {
  const { cursor, move, setCursor } = useListNavigation(stateCounts.length);
  const [indices, setIndices] = useState<ReadonlyArray<number>>(() =>
    stateCounts.map(() => 0),
  );
  const cycle = (delta: number) =>
    setIndices((current) =>
      current.map((value, index) => {
        if (index !== cursor) return value;
        const count = stateCounts[index] ?? 0;
        return count <= 0 ? 0 : (value + delta + count) % count;
      }),
    );
  return { cursor, indices, move, setCursor, cycle } as const;
};

export interface ExternalWaitProps {
  readonly message: string;
  readonly waitingLabel: string;
  readonly url?: string;
  readonly openFailed?: boolean;
  readonly onOpen?: () => Promise<void>;
  readonly inputLabel: string;
  readonly placeholder?: string;
  readonly validate?: (value: string) => string | Error | undefined;
  readonly onSubmit: (value: string) => void;
  readonly onCancel: () => void;
}

export const SearchField = ({
  value,
  onChange,
  onCancel,
  placeholder = "filter",
  active,
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onCancel?: () => void;
  readonly placeholder?: string;
  readonly active?: boolean;
}) => (
  <Box gap={1}>
    <Text tone="muted">Filter:</Text>
    <TextField
      value={value}
      placeholder={placeholder}
      active={active}
      onChange={onChange}
      onCancel={onCancel}
      onSubmit={() => undefined}
    />
  </Box>
);

export const InlineConfirm = ({
  message,
  initialValue = false,
  active,
  onSubmit,
  onCancel,
}: {
  readonly message: string;
  readonly initialValue?: boolean;
  readonly active?: boolean;
  readonly onSubmit: (value: boolean) => void;
  readonly onCancel?: () => void;
}) => {
  const focused = useFocus();
  const keys = useKeyGlyphs();
  const [value, setValue] = useState(initialValue);
  useTerminalInput(
    (input, key) => {
      if (key.escape) onCancel?.();
      else if (key.left || key.right || key.tab || key.up || key.down)
        setValue((current) => !current);
      else if (key.enter) onSubmit(value);
      else if (key.ctrl || key.meta) return;
      else if (input.toLowerCase() === "y") onSubmit(true);
      else if (input.toLowerCase() === "n") onSubmit(false);
    },
    { active: active ?? focused },
  );
  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>{message}</Text>
      <BooleanChoice value={value} />
      <KeyBar
        keys={[
          [keys.yesNo, "choose"],
          [keys.enter, "confirm"],
          [keys.escape, "cancel"],
        ]}
      />
    </Box>
  );
};

export const BooleanChoice = ({ value }: { readonly value: boolean }) => (
  <Box gap={1}>
    <Text
      bold={value}
      color={value ? theme.color.onAccent : undefined}
      backgroundColor={value ? theme.color.accentMuted : undefined}
    >
      {" Yes "}
    </Text>
    <Text
      bold={!value}
      color={!value ? theme.color.onAccent : undefined}
      backgroundColor={!value ? theme.color.accentMuted : undefined}
    >
      {" No "}
    </Text>
  </Box>
);

/** Browser/OAuth waiting screen with URL controls and manual-entry fallback. */
export const ExternalWait = ({
  message,
  waitingLabel,
  url,
  openFailed = false,
  onOpen,
  inputLabel,
  placeholder,
  validate,
  onSubmit,
  onCancel,
}: ExternalWaitProps) => {
  const { stdout } = useStdout();
  const glyphs = useGlyphs();
  const keyGlyphs = useKeyGlyphs();
  const [manual, setManual] = useState(false);
  const [showFull, setShowFull] = useState(false);
  const [copied, setCopied] = useState(false);
  const [browserFailed, setBrowserFailed] = useState(openFailed);
  const [error, setError] = useState<string>();
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  useEffect(
    () => () => {
      clearTimeout(copiedTimer.current);
    },
    [],
  );
  const { columns } = useTerminalSize();
  // Ctrl+C is handled centrally by the screen runner (InkRuntime.run).
  useTerminalInput((input, key) => {
    if (manual) {
      if (key.escape) {
        setError(undefined);
        setManual(false);
      }
      return;
    }
    const shortcut = input.toLowerCase();
    if (key.enter) setManual(true);
    else if (key.escape) onCancel();
    // Ctrl+C must fall through to the runner's cancel guard, not copy the URL.
    else if (key.ctrl || key.meta) return;
    else if (shortcut === "u") setShowFull((current) => !current);
    else if (shortcut === "o" && onOpen !== undefined) {
      setBrowserFailed(false);
      void onOpen().catch(() => setBrowserFailed(true));
    } else if (shortcut === "c" && url !== undefined) {
      copyToClipboard(url, stdout ?? process.stdout);
      setCopied(true);
      clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(false), 2000);
    }
  });
  if (manual) {
    return (
      <PromptFrame
        message={inputLabel}
        error={error}
        keys={[
          [keyGlyphs.enter, "confirm"],
          [keyGlyphs.escape, "back to waiting"],
        ]}
      >
        <TextField
          placeholder={placeholder}
          onCancel={() => {
            setError(undefined);
            setManual(false);
          }}
          onChange={() => setError(undefined)}
          onSubmit={(value) => {
            const problem = validate?.(value);
            if (problem !== undefined) {
              setError(problem instanceof Error ? problem.message : problem);
            } else {
              onSubmit(value);
            }
          }}
        />
      </PromptFrame>
    );
  }
  return (
    <PromptFrame
      message={message}
      keys={[
        [keyGlyphs.enter, "enter code manually"],
        ...(url === undefined
          ? []
          : ([
              ...(onOpen === undefined
                ? []
                : ([["o", "open browser"]] as const)),
              ["c", copied ? `${glyphs.success} copied` : "copy URL"],
            ] as const)),
        [keyGlyphs.escape, "cancel"],
      ]}
    >
      <Box flexDirection="column">
        <Spinner label={waitingLabel} />
        {browserFailed ? (
          <Text tone="warning">
            {glyphs.warning} Could not open the browser. Copy and open the URL
            manually.
          </Text>
        ) : null}
        {url === undefined ? null : (
          <Link href={url}>
            {showFull ? url : truncate(url, Math.max(24, columns - 8))}
          </Link>
        )}
      </Box>
    </PromptFrame>
  );
};

export const PromptFrame = ({
  message,
  children,
  error,
  keys,
}: {
  readonly message: string;
  readonly children: JSX.Element;
  readonly error?: string;
  readonly keys?: ReadonlyArray<readonly [string, string]>;
}) => {
  const glyphs = useGlyphs();
  return (
    <Box flexDirection="column" gap={1}>
      <Text>
        <Text color={theme.color.accent}>{glyphs.active}</Text>{" "}
        <Text bold>{message}</Text>
      </Text>
      <Box paddingLeft={2} flexDirection="column">
        {children}
      </Box>
      {error === undefined ? null : (
        <Box paddingLeft={2}>
          <Text color={theme.color.danger}>
            {glyphs.error} {error}
          </Text>
        </Box>
      )}
      {keys === undefined ? null : (
        <Box paddingLeft={2}>
          <KeyBar keys={keys} />
        </Box>
      )}
    </Box>
  );
};

export const filterChoices = <Value,>(
  choices: ReadonlyArray<Choice<Value>>,
  query: string,
) => {
  const normalized = query.trim().toLowerCase();
  const indexed = choices.map((choice, index) => ({ choice, index }));
  return normalized === ""
    ? indexed
    : indexed.filter(({ choice }) =>
        `${choice.group ?? ""} ${choice.label} ${choice.description ?? ""}`
          .toLowerCase()
          .includes(normalized),
      );
};

/** Stable selected-index set for multiselect widgets. */
export const useSelectedChoices = <Value,>(
  choices: ReadonlyArray<Choice<Value>>,
  initialValues: ReadonlyArray<Value>,
) => {
  return useState<ReadonlySet<number>>(
    () =>
      new Set(
        initialValues.flatMap((value) => {
          const index = choices.findIndex((choice) => choice.value === value);
          return index === -1 || choices[index]?.disabled ? [] : [index];
        }),
      ),
  );
};
