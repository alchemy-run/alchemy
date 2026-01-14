export * from "./attribute-value.ts";
export * from "./expr.ts";
export * from "./secondary-index.ts";
export * from "./table.consume.ts";
export * from "./table.event-source.ts";
export * from "./table.get-item.ts";
export * from "./table.provider.ts";
export * from "./table.ts";

// TODO(sam): figure out a better strategy to workaround non-portable types
export type * from "../../exports.ts";

import "../config.ts";
