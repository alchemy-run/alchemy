import type { AssetConfig } from "../types";
import type { ParsedRedirects } from "./types";
export declare function parseRedirects(
  input: string,
  {
    htmlHandling,
    maxStaticRules,
    maxDynamicRules,
    maxLineLength,
  }?: {
    htmlHandling?: AssetConfig["html_handling"];
    maxStaticRules?: number;
    maxDynamicRules?: number;
    maxLineLength?: number;
  },
): ParsedRedirects;
//# sourceMappingURL=parseRedirects.d.ts.map
