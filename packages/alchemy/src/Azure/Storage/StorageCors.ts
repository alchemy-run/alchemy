import type * as storage from "@distilled.cloud/azure/storage";

/** A CORS rule for a Storage service (File, Queue, or Table). */
export interface StorageCorsRule {
  /** Origins allowed to make cross-origin requests, or `["*"]`. */
  allowedOrigins: string[];
  /** HTTP methods the origins may use, e.g. `["GET", "PUT"]`. */
  allowedMethods: storage.AllowedMethods[];
  /** Request headers allowed in cross-origin requests. @default ["*"] */
  allowedHeaders?: string[];
  /** Response headers exposed to CORS clients. @default ["*"] */
  exposedHeaders?: string[];
  /** Seconds a browser may cache the preflight response. @default 3600 */
  maxAgeInSeconds?: number;
}

/** The wire shape of CORS rules, with defaults filled in. */
export const toStorageCorsRules = (
  rules: ReadonlyArray<StorageCorsRule>,
): storage.CorsRule[] =>
  rules.map((rule) => ({
    allowedOrigins: rule.allowedOrigins,
    allowedMethods: rule.allowedMethods,
    allowedHeaders: rule.allowedHeaders ?? ["*"],
    exposedHeaders: rule.exposedHeaders ?? ["*"],
    maxAgeInSeconds: rule.maxAgeInSeconds ?? 3600,
  }));

/** The attribute shape of observed CORS rules. */
export const fromStorageCorsRules = (
  cors: storage.CorsRules | undefined,
): StorageCorsRule[] =>
  (cors?.corsRules ?? []).map((rule) => ({
    allowedOrigins: [...rule.allowedOrigins],
    allowedMethods: [...rule.allowedMethods] as storage.AllowedMethods[],
    allowedHeaders: [...rule.allowedHeaders],
    exposedHeaders: [...rule.exposedHeaders],
    maxAgeInSeconds: rule.maxAgeInSeconds,
  }));

/** CORS rules compare order-sensitively on their canonical JSON. */
export const storageCorsDiffers = (
  observed: ReadonlyArray<StorageCorsRule>,
  desired: ReadonlyArray<StorageCorsRule>,
) =>
  JSON.stringify(toStorageCorsRules(observed)) !==
  JSON.stringify(toStorageCorsRules(desired));
