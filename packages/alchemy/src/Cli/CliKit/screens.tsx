/** @jsxImportSource react */
import { type ReactNode, useEffect, useMemo, useState } from "react";
import type {
  ConfirmOptions,
  CycleSelectOptions,
  AwaitExternalOptions,
  MenuOptions,
  MultiSelectOptions,
  PasswordInputOptions,
  Screen,
  SelectOptions,
  TextInputOptions,
} from "./types.ts";
import { theme } from "./theme.ts";
import { useGlyphs, useKeyGlyphs } from "./components/Environment.tsx";
import { Alert } from "./components/Feedback.tsx";
import {
  BooleanChoice,
  filterChoices,
  CycleList,
  ExternalWait,
  jumpSkippingDisabled,
  Menu,
  moveSkippingDisabled,
  PromptFrame,
  sanitizeTextInsert,
  TextField,
  useListNavigation,
  useSelectedChoices,
  useTerminalInput,
  useTerminalSize,
  useCycleNavigation,
} from "./components/Interactive.tsx";
import { Box } from "./components/Layout.tsx";
import { AnsweredPrompt } from "./components/Transcript.tsx";
import { Text } from "./components/Typography.tsx";

const errorMessage = (value: string | Error | undefined) =>
  value instanceof Error ? value.message : value;

/**
 * Escape-to-cancel for standard prompts. Ctrl+C is handled centrally by the
 * screen runner (InkRuntime.run), so screens only wire Escape semantics.
 */
const useCancel = (cancel: () => void) =>
  useTerminalInput((_input, key) => {
    if (key.escape) cancel();
  });

const TextPrompt = ({
  options,
  mask,
  submit,
  cancel,
}: {
  readonly options: TextInputOptions | PasswordInputOptions;
  readonly mask?: boolean;
  readonly submit: (value: string, summary?: ReactNode) => void;
  readonly cancel: () => void;
}) => {
  const glyphs = useGlyphs();
  const keys = useKeyGlyphs();
  const maskGlyph = mask ? glyphs.mask : undefined;
  const [error, setError] = useState<string>();
  useCancel(cancel);
  const complete = (raw: string) => {
    const value =
      raw === "" &&
      "defaultValue" in options &&
      options.defaultValue !== undefined
        ? options.defaultValue
        : raw;
    const problem = errorMessage(options.validate?.(value));
    if (problem !== undefined) setError(problem);
    else
      submit(
        value,
        <AnsweredPrompt
          message={options.message}
          answer={
            maskGlyph === undefined
              ? value || "(empty)"
              : maskGlyph.repeat(Math.min(value.length, 12))
          }
        />,
      );
  };
  return (
    <PromptFrame
      message={options.message}
      error={error}
      keys={[
        [keys.enter, "confirm"],
        [keys.escape, "cancel"],
      ]}
    >
      <TextField
        placeholder={options.placeholder}
        initialValue={
          "initialValue" in options ? options.initialValue : undefined
        }
        mask={maskGlyph}
        onChange={() => setError(undefined)}
        onSubmit={complete}
      />
    </PromptFrame>
  );
};

export const textScreen = (options: TextInputOptions): Screen<string> => ({
  name: "text input",
  render: ({ submit, cancel }) => (
    <TextPrompt options={options} submit={submit} cancel={cancel} />
  ),
});

export const passwordScreen = (
  options: PasswordInputOptions,
): Screen<string> => ({
  name: "password input",
  render: ({ submit, cancel }) => (
    <TextPrompt options={options} mask submit={submit} cancel={cancel} />
  ),
});

const SelectPrompt = <Value,>({
  options,
  submit,
  cancel,
  summary = true,
  header,
  footer,
  escapeLabel = "cancel",
}: {
  readonly options: SelectOptions<Value>;
  readonly submit: (value: Value, summary?: ReactNode) => void;
  readonly cancel: () => void;
  readonly summary?: boolean;
  readonly header?: ReactNode;
  readonly footer?: ReactNode;
  readonly escapeLabel?: string;
}) => {
  const keys = useKeyGlyphs();
  const { rows } = useTerminalSize();
  const visibleCount =
    options.visibleCount ?? Math.max(3, Math.min(16, rows - 8));
  const searchable = options.searchable === true;
  const [query, setQuery] = useState("");
  const filtered = useMemo(
    () =>
      searchable
        ? filterChoices(options.options, query)
        : options.options.map((choice, index) => ({ choice, index })),
    [options.options, query, searchable],
  );
  const initialOriginalIndex = options.options.findIndex(
    (choice) => choice.value === options.initialValue,
  );
  const initialIndex = filtered.findIndex(
    ({ index }) => index === initialOriginalIndex,
  );
  const firstEnabled = filtered.findIndex(({ choice }) => !choice.disabled);
  const { cursor, setCursor } = useListNavigation(
    filtered.length,
    initialIndex !== -1 && !filtered[initialIndex]?.choice.disabled
      ? initialIndex
      : Math.max(0, firstEnabled),
  );
  const disabled = useMemo(
    () =>
      filtered.map(
        ({ choice }) =>
          choice.disabled !== undefined && choice.disabled !== false,
      ),
    [filtered],
  );
  useEffect(() => {
    setCursor((current) => {
      if (filtered.length === 0) return 0;
      const clamped = Math.min(current, filtered.length - 1);
      if (!disabled[clamped]) return clamped;
      const enabled = disabled.findIndex((value) => !value);
      return enabled === -1 ? clamped : enabled;
    });
  }, [disabled, filtered.length, setCursor]);
  const page = Math.max(1, visibleCount);
  useTerminalInput((input, key) => {
    const plain = !key.ctrl && !key.meta;
    if (key.up || (!searchable && plain && input === "k"))
      setCursor(moveSkippingDisabled(disabled, cursor, -1));
    else if (key.down || (!searchable && plain && input === "j"))
      setCursor(moveSkippingDisabled(disabled, cursor, 1));
    else if (key.home) setCursor(jumpSkippingDisabled(disabled, cursor, 0));
    else if (key.end)
      setCursor(jumpSkippingDisabled(disabled, cursor, disabled.length - 1));
    else if (key.pageUp)
      setCursor(jumpSkippingDisabled(disabled, cursor, cursor - page));
    else if (key.pageDown)
      setCursor(jumpSkippingDisabled(disabled, cursor, cursor + page));
    else if (key.escape) {
      if (query !== "") {
        setQuery("");
        setCursor(0);
      } else cancel();
    } else if (searchable && (key.backspace || key.delete)) {
      setQuery((current) => current.slice(0, -1));
      setCursor(0);
    } else if (key.enter) {
      const choice = filtered[cursor]?.choice;
      if (choice !== undefined && !choice.disabled) {
        submit(
          choice.value,
          summary ? (
            <AnsweredPrompt message={options.message} answer={choice.label} />
          ) : undefined,
        );
      }
    } else if (searchable && plain && !key.tab) {
      const typed = sanitizeTextInsert(input);
      if (typed.length > 0) {
        setQuery((current) => current + typed);
        setCursor(0);
      }
    }
  });
  return (
    <Box flexDirection="column" gap={1}>
      {header}
      <PromptFrame
        message={options.message}
        keys={[
          [keys.upDown, "navigate"],
          [keys.enter, "select"],
          [keys.escape, query === "" ? escapeLabel : "clear filter"],
        ]}
      >
        <Box flexDirection="column">
          {searchable ? (
            <Text tone="muted">
              Filter: <Text color={theme.color.info}>{query || "all"}</Text>
            </Text>
          ) : null}
          <Menu
            choices={filtered.map(({ choice }) => choice)}
            cursor={cursor}
            visibleCount={visibleCount}
            empty="No matching choices."
            descriptionPlacement={options.descriptionPlacement}
          />
        </Box>
      </PromptFrame>
      {footer}
    </Box>
  );
};

export const selectScreen = <Value,>(
  options: SelectOptions<Value>,
): Screen<Value> => ({
  name: "selection",
  render: ({ submit, cancel }) => (
    <SelectPrompt options={options} submit={submit} cancel={cancel} />
  ),
});

export const menuScreen = <Value,>(
  options: MenuOptions<Value>,
): Screen<Value> => {
  const hasBack = Object.hasOwn(options, "back");
  return {
    name: "menu",
    render: ({ submit, cancel }) => (
      <SelectPrompt
        options={options}
        submit={submit}
        cancel={() => (hasBack ? submit(options.back as Value) : cancel())}
        summary={false}
        header={options.header}
        footer={options.footer}
        escapeLabel={hasBack ? "back" : "exit"}
      />
    ),
  };
};

const MultiSelectPrompt = <Value,>({
  options,
  submit,
  cancel,
}: {
  readonly options: MultiSelectOptions<Value>;
  readonly submit: (value: ReadonlyArray<Value>, summary?: ReactNode) => void;
  readonly cancel: () => void;
}) => {
  const keys = useKeyGlyphs();
  const { rows } = useTerminalSize();
  const visibleCount =
    options.visibleCount ?? Math.max(3, Math.min(16, rows - 10));
  const [query, setQuery] = useState("");
  const filtered = useMemo(
    () =>
      options.searchable === false
        ? options.options.map((choice, index) => ({ choice, index }))
        : filterChoices(options.options, query),
    [options.options, options.searchable, query],
  );
  const listRows = useMemo(() => {
    const result: Array<
      | {
          readonly type: "group";
          readonly label: string;
          readonly indices: number[];
        }
      | {
          readonly type: "choice";
          readonly choice: (typeof filtered)[number]["choice"];
          readonly index: number;
          readonly nested: boolean;
        }
    > = [];
    let currentGroup: string | undefined;
    for (const entry of filtered) {
      const group = entry.choice.group;
      if (group !== undefined) {
        if (currentGroup !== group) {
          result.push({
            type: "group",
            label: group,
            indices: filtered
              .filter(({ choice }) => choice.group === group)
              .map(({ index }) => index),
          });
        }
      }
      currentGroup = group;
      result.push({
        type: "choice",
        choice: entry.choice,
        index: entry.index,
        nested: group !== undefined,
      });
    }
    return result;
  }, [filtered]);
  const { cursor, setCursor } = useListNavigation(listRows.length);
  const [selected, setSelected] = useSelectedChoices(
    options.options,
    options.initialValues ?? [],
  );
  const [error, setError] = useState<string>();
  const disabled = useMemo(
    () =>
      listRows.map((row) =>
        row.type === "choice"
          ? row.choice.disabled !== undefined && row.choice.disabled !== false
          : row.indices.every((index) =>
              Boolean(options.options[index]?.disabled),
            ),
      ),
    [listRows, options.options],
  );
  useEffect(() => {
    setCursor((current) => {
      if (listRows.length === 0) return 0;
      const clamped = Math.min(current, listRows.length - 1);
      if (!disabled[clamped]) return clamped;
      const enabled = disabled.findIndex((value) => !value);
      return enabled === -1 ? clamped : enabled;
    });
  }, [disabled, listRows.length, setCursor]);
  const page = Math.max(1, visibleCount);
  useTerminalInput((input, key) => {
    const plain = !key.ctrl && !key.meta;
    if (key.up || (options.searchable === false && plain && input === "k"))
      setCursor(moveSkippingDisabled(disabled, cursor, -1));
    else if (
      key.down ||
      (options.searchable === false && plain && input === "j")
    )
      setCursor(moveSkippingDisabled(disabled, cursor, 1));
    else if (key.home) setCursor(jumpSkippingDisabled(disabled, cursor, 0));
    else if (key.end)
      setCursor(jumpSkippingDisabled(disabled, cursor, disabled.length - 1));
    else if (key.pageUp)
      setCursor(jumpSkippingDisabled(disabled, cursor, cursor - page));
    else if (key.pageDown)
      setCursor(jumpSkippingDisabled(disabled, cursor, cursor + page));
    else if (key.escape) {
      // An active filter absorbs the first Escape; the second cancels.
      if (query !== "") {
        setQuery("");
        setCursor(0);
      } else cancel();
    } else if (key.ctrl && input === "a") {
      const enabledVisible = filtered.flatMap(({ choice, index }) =>
        choice.disabled !== undefined && choice.disabled !== false
          ? []
          : [index],
      );
      if (enabledVisible.length === 0) return;
      setSelected((current) => {
        const next = new Set(current);
        const allSelected = enabledVisible.every((index) => next.has(index));
        for (const index of enabledVisible) {
          if (allSelected) next.delete(index);
          else next.add(index);
        }
        return next;
      });
      setError(undefined);
    } else if (input === " " && !key.ctrl && !key.meta) {
      const row = listRows[cursor];
      if (row === undefined) return;
      const indices =
        row.type === "group"
          ? row.indices.filter((index) => !options.options[index]?.disabled)
          : row.choice.disabled
            ? []
            : [row.index];
      if (indices.length === 0) return;
      setSelected((current) => {
        const next = new Set(current);
        const allSelected = indices.every((index) => next.has(index));
        for (const index of indices) {
          if (allSelected) next.delete(index);
          else next.add(index);
        }
        return next;
      });
      setError(undefined);
    } else if (key.enter) {
      if (options.required && selected.size === 0) {
        setError("Select at least one option.");
        return;
      }
      const values = options.options.flatMap((choice, index) =>
        selected.has(index) ? [choice.value] : [],
      );
      const labels = options.options.flatMap((choice, index) =>
        selected.has(index) ? [choice.label] : [],
      );
      submit(
        values,
        <AnsweredPrompt
          message={options.message}
          answer={labels.length === 0 ? "none" : labels.join(", ")}
        />,
      );
      // Most terminals send DEL (0x7f) for Backspace, surfaced by ink as
      // `key.delete`; `key.backspace` is Ctrl+H. Both erase from the filter.
    } else if (options.searchable !== false && (key.backspace || key.delete)) {
      setQuery((current) => current.slice(0, -1));
      setCursor(0);
    } else if (
      options.searchable !== false &&
      !key.ctrl &&
      !key.meta &&
      !key.tab
    ) {
      const typed = sanitizeTextInsert(input);
      if (typed.length === 0) return;
      setQuery((current) => current + typed);
      setCursor(0);
    }
  });
  const visibleChoices = listRows.map((row) =>
    row.type === "group"
      ? {
          value: row,
          label: row.label,
          sticky: true,
          tone: "info" as const,
        }
      : {
          ...row.choice,
          value: row,
          group: undefined,
          indent: row.nested ? 2 : row.choice.indent,
        },
  );
  const visibleSelected = new Set(
    listRows.flatMap((row, visibleIndex) =>
      (
        row.type === "group"
          ? row.indices.length > 0 &&
            row.indices.every((index) => selected.has(index))
          : selected.has(row.index)
      )
        ? [visibleIndex]
        : [],
    ),
  );
  return (
    <PromptFrame
      message={options.message}
      error={error}
      keys={[
        [keys.upDown, "navigate"],
        [keys.space, "toggle"],
        ["ctrl+a", "toggle all"],
        [keys.enter, "confirm"],
        [keys.escape, query === "" ? "cancel" : "clear filter"],
      ]}
    >
      <Box flexDirection="column">
        {options.searchable === false ? null : (
          <Text tone="muted">
            Filter: <Text color={theme.color.info}>{query || "all"}</Text>
            {" · "}
            {selected.size} selected
          </Text>
        )}
        <Menu<(typeof listRows)[number]>
          choices={visibleChoices}
          cursor={cursor}
          selected={visibleSelected}
          visibleCount={visibleCount}
          empty="No matching choices."
          descriptionPlacement={options.descriptionPlacement}
        />
      </Box>
    </PromptFrame>
  );
};

export const multiSelectScreen = <Value,>(
  options: MultiSelectOptions<Value>,
): Screen<ReadonlyArray<Value>> => ({
  name: "multiple selection",
  render: ({ submit, cancel }) => (
    <MultiSelectPrompt options={options} submit={submit} cancel={cancel} />
  ),
});

const CycleSelectPrompt = <State,>({
  options,
  submit,
  cancel,
}: {
  readonly options: CycleSelectOptions<State>;
  readonly submit: (value: ReadonlyArray<State>, summary?: ReactNode) => void;
  readonly cancel: () => void;
}) => {
  const keys = useKeyGlyphs();
  const { rows } = useTerminalSize();
  const visibleCount =
    options.visibleCount ?? Math.max(3, Math.min(16, rows - 8));
  const navigation = useCycleNavigation(
    options.options.map((choice) => choice.states.length),
  );
  const [unchanged, setUnchanged] = useState(false);
  useCancel(cancel);
  const last = Math.max(0, options.options.length - 1);
  const page = Math.max(1, visibleCount);
  useTerminalInput((input, key) => {
    const plain = !key.ctrl && !key.meta;
    if (key.up || (plain && input === "k")) navigation.move(-1);
    else if (key.down || (plain && input === "j")) navigation.move(1);
    else if (key.home) navigation.setCursor(0);
    else if (key.end) navigation.setCursor(last);
    else if (key.pageUp)
      navigation.setCursor(Math.max(0, navigation.cursor - page));
    else if (key.pageDown)
      navigation.setCursor(Math.min(last, navigation.cursor + page));
    else if ((plain && input === " ") || key.right) {
      navigation.cycle(1);
      setUnchanged(false);
    } else if (key.left) {
      navigation.cycle(-1);
      setUnchanged(false);
    } else if (key.enter) {
      if (
        options.requireChange &&
        navigation.indices.every((index) => index === 0)
      ) {
        setUnchanged(true);
        return;
      }
      const values = options.options.flatMap((choice, index) => {
        const state = choice.states[navigation.indices[index] ?? 0];
        return state === undefined ? [] : [state.value];
      });
      const changed = options.options.flatMap((choice, index) => {
        if ((navigation.indices[index] ?? 0) === 0) return [];
        const state = choice.states[navigation.indices[index] ?? 0];
        return state === undefined
          ? []
          : [`${choice.label}: ${state.label ?? "changed"}`];
      });
      submit(
        values,
        <AnsweredPrompt
          message={options.message}
          answer={changed.length === 0 ? "no changes" : changed.join(", ")}
        />,
      );
    }
  });
  return (
    <PromptFrame
      message={options.message}
      keys={[
        [keys.upDown, "navigate"],
        [keys.space, "change"],
        [keys.enter, options.requireChange ? "apply" : "confirm"],
        [keys.escape, options.requireChange ? "back" : "cancel"],
      ]}
    >
      <Box flexDirection="column" gap={1}>
        <CycleList
          choices={options.options}
          cursor={navigation.cursor}
          indices={navigation.indices}
          visibleCount={visibleCount}
        />
        {unchanged ? (
          <Alert variant="warning" title="No changes to apply">
            {options.unchangedMessage ??
              "Press Space to change a selection, or Esc to go back."}
          </Alert>
        ) : null}
      </Box>
    </PromptFrame>
  );
};

export const cycleSelectScreen = <State,>(
  options: CycleSelectOptions<State>,
): Screen<ReadonlyArray<State>> => ({
  name: "cycle selection",
  render: ({ submit, cancel }) => (
    <CycleSelectPrompt options={options} submit={submit} cancel={cancel} />
  ),
});

export const awaitExternalScreen = (
  options: AwaitExternalOptions,
): Screen<string> => ({
  name: "external authorization",
  render: ({ submit, cancel }) => (
    <ExternalWait {...options} onSubmit={submit} onCancel={cancel} />
  ),
});

const ConfirmPrompt = ({
  options,
  submit,
  cancel,
}: {
  readonly options: ConfirmOptions;
  readonly submit: (value: boolean, summary?: ReactNode) => void;
  readonly cancel: () => void;
}) => {
  const keys = useKeyGlyphs();
  const [value, setValue] = useState(options.initialValue ?? true);
  useCancel(cancel);
  const complete = (answer: boolean) =>
    submit(
      answer,
      <AnsweredPrompt
        message={options.message}
        answer={answer ? "yes" : "no"}
      />,
    );
  useTerminalInput((input, key) => {
    if (key.left || key.right || key.tab || key.up || key.down)
      setValue((current) => !current);
    else if (key.enter) complete(value);
    else if (key.ctrl || key.meta) return;
    else if (input.toLowerCase() === "y") complete(true);
    else if (input.toLowerCase() === "n") complete(false);
  });
  return (
    <PromptFrame
      message={options.message}
      keys={[
        [keys.yesNo, "choose"],
        [keys.enter, "confirm"],
        [keys.escape, "cancel"],
      ]}
    >
      <BooleanChoice value={value} />
    </PromptFrame>
  );
};

export const confirmScreen = (options: ConfirmOptions): Screen<boolean> => ({
  name: "confirmation",
  render: ({ submit, cancel }) => (
    <ConfirmPrompt options={options} submit={submit} cancel={cancel} />
  ),
});
