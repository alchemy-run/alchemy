import { Toucan } from "toucan-js";
import type { ColoMetadata } from "./types.ts";
export declare function setupSentry(
  request: Request,
  context: ExecutionContext | undefined,
  dsn: string,
  clientId: string,
  clientSecret: string,
  coloMetadata?: ColoMetadata,
  versionMetadata?: WorkerVersionMetadata,
  accountId?: number,
  scriptId?: number,
): Toucan | undefined;
//# sourceMappingURL=sentry.d.ts.map
