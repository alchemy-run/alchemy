import type { AssetConfig } from "../../shared/types";
import type {
  Logger,
  ParsedHeaders,
  ParsedRedirects,
} from "../../shared/configuration/types";
export declare function constructRedirects({
  redirects,
  redirectsFile,
  logger,
}: {
  redirects?: ParsedRedirects;
  redirectsFile?: string;
  logger: Logger;
}): Pick<AssetConfig, "redirects">;
export declare function constructHeaders({
  headers,
  headersFile,
  logger,
}: {
  headers?: ParsedHeaders;
  headersFile?: string;
  logger: Logger;
}): Pick<AssetConfig, "headers">;
//# sourceMappingURL=constructConfiguration.d.ts.map
