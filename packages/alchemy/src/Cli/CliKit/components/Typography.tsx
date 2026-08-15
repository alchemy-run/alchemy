/** @jsxImportSource react */
import { Text as InkText } from "ink";
import type { ComponentProps } from "react";
import { theme } from "../theme.ts";
import { hyperlink } from "../terminal.ts";

export type TextTone =
  | "default"
  | "muted"
  | "emphasis"
  | "brand"
  | "accent"
  | "info"
  | "success"
  | "warning"
  | "danger";

export interface TextProps extends Omit<
  ComponentProps<typeof InkText>,
  "color"
> {
  readonly tone?: TextTone;
  readonly color?: string;
}

/** CliKit typography primitive. Consumers never need to import Ink directly. */
export const Text = ({
  tone = "default",
  color,
  dimColor,
  ...props
}: TextProps) => (
  <InkText
    {...props}
    color={
      color ??
      (tone === "default" || tone === "muted" ? undefined : theme.color[tone])
    }
    dimColor={dimColor ?? tone === "muted"}
  />
);

export const Link = ({
  href,
  children,
}: {
  readonly href: string;
  readonly children?: string;
}) => (
  <Text tone="info" underline>
    {hyperlink(children ?? href, href)}
  </Text>
);
