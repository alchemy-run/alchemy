/**
 * Composable terminal layouts and interaction widgets.
 *
 * This is a separate entrypoint from `alchemy/Cli/CliKit` so importing the
 * injectable service does not eagerly load React, Ink or Yoga.
 */
export {
  CliEnvironment,
  useCliEnvironment,
  useGlyphs,
  useKeyGlyphs,
} from "./components/Environment.tsx";
export {
  Box,
  Code,
  Columns,
  Divider,
  Gutter,
  Heading,
  Muted,
  Panel,
  Row,
  SectionHeading,
  Spacer,
  Stack,
  type BoxProps,
  type PanelProps,
  type RowProps,
  type StackProps,
} from "./components/Layout.tsx";
export {
  Link,
  Text,
  type TextProps,
  type TextTone,
} from "./components/Typography.tsx";
export {
  Alert,
  Badge,
  KeyBar,
  ProgressBar,
  Spinner,
  SpinnerGlyph,
  Status,
  Tabs,
  useSpinnerFrame,
  type AlertProps,
  type BadgeVariant,
  type StatusProps,
} from "./components/Feedback.tsx";
export {
  DescriptionList,
  Table,
  type DescriptionItem,
  type TableColumn,
  type TableProps,
} from "./components/Data.tsx";
export {
  BooleanChoice,
  Menu,
  CycleList,
  ExternalWait,
  InlineConfirm,
  PromptFrame,
  SearchField,
  TextField,
  filterChoices,
  jumpSkippingDisabled,
  moveSkippingDisabled,
  sanitizeTextInsert,
  useListNavigation,
  useCycleNavigation,
  useSelectedChoices,
  useTerminalInput,
  useTerminalSize,
  type MenuProps,
  type CycleListProps,
  type ExternalWaitProps,
  type TerminalKey,
  type TextFieldProps,
} from "./components/Interactive.tsx";
export {
  AppShell,
  FocusScope,
  MasterDetail,
  Notice,
  Viewport,
  useFocus,
  useScreenStack,
  type ScreenStack,
} from "./components/Application.tsx";
export {
  AnsweredPrompt,
  CancelledPrompt,
  Transcript,
  TranscriptStore,
  type TranscriptEntry,
} from "./components/Transcript.tsx";
export {
  ConsoleFeed,
  ConsoleFeedView,
  interceptConsole,
  LiveStore,
  ProgressGroup,
  TaskRow,
  TaskTree,
  useLiveStore,
  type ConsoleEntry,
  type ConsoleMethod,
  type ProgressGroupRow,
  type TaskNode,
  type TaskRowProps,
  type TaskStatus,
} from "./components/Live.tsx";
