/** @jsxImportSource react */
import { useStdout } from "ink";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { CliKitCapabilities } from "../types.ts";
import { glyphsFor, theme, type KeyHint } from "../theme.ts";

const defaults: CliKitCapabilities = {
  input: false,
  columns: 80,
  rows: 24,
  colors: false,
  unicode: true,
};

const EnvironmentContext = createContext<CliKitCapabilities>(defaults);

export const CliEnvironment = ({
  capabilities,
  children,
}: {
  readonly capabilities: CliKitCapabilities;
  readonly children?: ReactNode;
}) => {
  const { stdout } = useStdout();
  const [size, setSize] = useState(() => ({
    columns: stdout?.columns ?? capabilities.columns,
    rows: stdout?.rows ?? capabilities.rows,
  }));
  useEffect(() => {
    const update = () =>
      setSize({
        columns: stdout?.columns ?? capabilities.columns,
        rows: stdout?.rows ?? capabilities.rows,
      });
    stdout?.on?.("resize", update);
    return () => {
      stdout?.off?.("resize", update);
    };
  }, [capabilities.columns, capabilities.rows, stdout]);
  const environment = useMemo(
    () => ({ ...capabilities, ...size }),
    [capabilities, size],
  );
  return (
    <EnvironmentContext.Provider value={environment}>
      {children}
    </EnvironmentContext.Provider>
  );
};

export const useCliEnvironment = () => useContext(EnvironmentContext);

export const useGlyphs = () => glyphsFor(useCliEnvironment().unicode);

const asciiKeyHint: KeyHint = {
  enter: "enter",
  upDown: "up/down",
  leftRight: "left/right",
  escape: "esc",
  space: "space",
  tab: "tab",
  yesNo: "y/n",
};

/** Key-hint labels for `KeyBar` footers, honoring the ASCII fallback. */
export const useKeyGlyphs = (): KeyHint =>
  useCliEnvironment().unicode ? theme.keyHint : asciiKeyHint;
