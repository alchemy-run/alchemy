import type { WorkerProps } from "./Worker.ts";

export const getCompatibility = (props: WorkerProps) => ({
  date: props.compatibility?.date ?? "2026-04-21",
  flags: [
    ...(props.compatibility?.flags ?? []),
    ...(props.isExternal ? [] : ["nodejs_compat"]),
  ].filter((value, index, self) => self.indexOf(value) === index),
});
