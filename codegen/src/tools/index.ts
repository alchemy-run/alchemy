import { Toolkit } from "@effect/ai";
import * as Layer from "effect/Layer";
import { editTooklit, editTooklitLayer } from "./edit.ts";
import { globTooklit, globTooklitLayer } from "./glob.ts";
import { grepTooklit, grepTooklitLayer } from "./grep.ts";
import { readTooklit, readTooklitLayer } from "./read.ts";
import { writeTooklit, writeTooklitLayer } from "./write.ts";
import { bashTooklit, bashTooklitLayer } from "./bash.ts";
import * as Scope from "effect/Scope";

export const toolkit = Toolkit.merge(
  editTooklit,
  globTooklit,
  grepTooklit,
  readTooklit,
  writeTooklit,
  // bashTooklit,
);

export const toolkitLayer = Layer.mergeAll(
  editTooklitLayer,
  globTooklitLayer,
  grepTooklitLayer,
  readTooklitLayer,
  writeTooklitLayer,
  // bashTooklitLayer,
);
