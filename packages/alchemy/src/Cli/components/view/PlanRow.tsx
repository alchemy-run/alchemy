/** @jsxImportSource react */
/**
 * Shared row shapes for the plan tree. Both the approved plan (Plan.tsx) and
 * the applying plan render namespaces through PlanView, this one
 * component so the two views look like the same tree.
 */
import type { JSX } from "react";
import { Row, Text, useGlyphs } from "../ui/index.ts";
import { theme } from "../../CliKit/index.ts";
import { actionStyle, type PlanAction } from "./statusStyle.ts";

export const namespaceStyle = (
  action: string,
): (typeof actionStyle)[PlanAction] =>
  actionStyle[action as PlanAction] ?? {
    color: theme.color.muted,
    icon: "info",
  };

/** A namespace node: rolled-up action icon + accent-colored id. */
type NamespaceRowProps = {
  readonly id: string;
  readonly depth: number;
  readonly action: string;
};

export function NamespaceRow({
  id,
  depth,
  action,
}: NamespaceRowProps): JSX.Element {
  const style = namespaceStyle(action);
  const glyphs = useGlyphs();
  return (
    <Row gap={1} paddingLeft={depth * 2}>
      <Text color={style.color}>{glyphs[style.icon]}</Text>
      <Text color={theme.color.accent}>{id}</Text>
    </Row>
  );
}
