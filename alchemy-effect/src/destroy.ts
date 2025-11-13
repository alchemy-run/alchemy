import { apply } from "./apply.ts";

export const destroy = () =>
  apply({
    phase: "destroy",
    resources: [],
  });
