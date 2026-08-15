/** @jsxImportSource react */
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";
import type { StatusVariant } from "../theme.ts";
import { Box, Panel, Row, Stack } from "./Layout.tsx";
import { Status } from "./Feedback.tsx";

const FocusContext = createContext(true);

/** Enables or suspends input handling for a subtree. */
export const FocusScope = ({
  active = true,
  children,
}: {
  readonly active?: boolean;
  readonly children?: ReactNode;
}) => <FocusContext.Provider value={active}>{children}</FocusContext.Provider>;

export const useFocus = () => useContext(FocusContext);

export const AppShell = ({
  header,
  children,
  footer,
}: {
  readonly header?: ReactNode;
  readonly children?: ReactNode;
  readonly footer?: ReactNode;
}) => (
  <Stack>
    {header === undefined ? null : <Box flexShrink={0}>{header}</Box>}
    <Box flexDirection="column" flexGrow={1}>
      {children}
    </Box>
    {footer === undefined ? null : <Box flexShrink={0}>{footer}</Box>}
  </Stack>
);

export const MasterDetail = ({
  master,
  detail,
  compact = false,
  masterWidth = 28,
}: {
  readonly master: ReactNode;
  readonly detail: ReactNode;
  readonly compact?: boolean;
  readonly masterWidth?: number;
}) =>
  compact ? (
    <Stack gap={1}>
      {master}
      {detail}
    </Stack>
  ) : (
    <Row width="100%" gap={2}>
      <Panel width={masterWidth}>{master}</Panel>
      <Panel grow={1}>{detail}</Panel>
    </Row>
  );

export const Notice = ({
  variant = "info",
  children,
}: {
  readonly variant?: StatusVariant;
  readonly children?: ReactNode;
}) => <Status variant={variant}>{children}</Status>;

export interface ScreenStack<Route> {
  readonly current: Route;
  readonly canGoBack: boolean;
  readonly push: (route: Route) => void;
  readonly replace: (route: Route) => void;
  readonly back: () => void;
  readonly reset: (route: Route) => void;
}

/** Local navigation state for custom CliKit application screens. */
export const useScreenStack = <Route,>(initial: Route): ScreenStack<Route> => {
  const [routes, setRoutes] = useState<ReadonlyArray<Route>>([initial]);
  const push = useCallback(
    (route: Route) => setRoutes((current) => [...current, route]),
    [],
  );
  const replace = useCallback(
    (route: Route) => setRoutes((current) => [...current.slice(0, -1), route]),
    [],
  );
  const back = useCallback(
    () =>
      setRoutes((current) =>
        current.length > 1 ? current.slice(0, -1) : current,
      ),
    [],
  );
  const reset = useCallback((route: Route) => setRoutes([route]), []);
  return useMemo(
    () => ({
      current: routes[routes.length - 1]!,
      canGoBack: routes.length > 1,
      push,
      replace,
      back,
      reset,
    }),
    [back, push, replace, reset, routes],
  );
};

export const Viewport = <Item,>({
  items,
  cursor = 0,
  height,
  renderItem,
  getKey,
  empty,
}: {
  readonly items: ReadonlyArray<Item>;
  readonly cursor?: number;
  readonly height: number;
  readonly renderItem: (item: Item, index: number) => ReactNode;
  readonly getKey: (item: Item, index: number) => string;
  readonly empty?: ReactNode;
}) => {
  if (items.length === 0) return <>{empty}</>;
  const count = Math.max(1, height);
  const selected = Math.max(0, Math.min(cursor, items.length - 1));
  const start = Math.max(
    0,
    Math.min(selected - Math.floor(count / 2), items.length - count),
  );
  const end = Math.min(items.length, start + count);
  return (
    <Stack>
      {items.slice(start, end).map((item, offset) => {
        const index = start + offset;
        return <Box key={getKey(item, index)}>{renderItem(item, index)}</Box>;
      })}
    </Stack>
  );
};
