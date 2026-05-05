/**
 * Shape of the per-binding `hyperdrives` entry the cloudflare-runtime
 * sidecar expects. Mirrors what the runtime sets up internally so the
 * dev-mode local DB feature works.
 *
 * `@distilled.cloud/cloudflare-runtime` doesn't yet export a public
 * `HyperdriveOrigin` type (see https://github.com/...). Defined here
 * locally so the Worker bundling pipeline stays type-safe; can be
 * replaced with a re-export once the runtime ships it.
 */
export interface HyperdriveOrigin {
  scheme: "postgres" | "postgresql" | "mysql";
  host: string;
  port: number;
  user: string;
  database: string;
  password: string;
}
