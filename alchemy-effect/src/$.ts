import { type Instance, Policy } from "./policy.ts";
import { isResource } from "./resource.ts";
import * as Output from "./output.ts";

export type $ = typeof Policy & typeof Output.interpolate & typeof Output.of;
export const $ = ((...args: any[]) =>
  Array.isArray(args[0])
    ? Output.interpolate(
        args[0] as unknown as TemplateStringsArray,
        ...args.slice(1),
      )
    : isResource(args[0])
      ? Output.of(args[0])
      : Policy(...args)) as $;
