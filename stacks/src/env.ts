import type { AlchemyOptions, Phase } from "alchemy";
import alchemy from "alchemy";
import { CloudflareStateStore } from "alchemy/state";

export const CLOUDFLARE_EMAIL = alchemy.env.CLOUDFLARE_EMAIL;

export const CLOUDFLARE_ACCOUNT_ID = alchemy.env.CLOUDFLARE_ACCOUNT_ID;

export const CLOUDFLARE_API_KEY = alchemy.secret.env.CLOUDFLARE_API_KEY;

export const STRIPE_API_KEY = alchemy.secret.env.STRIPE_API_KEY;

export const OPENAI_API_KEY = alchemy.secret.env.OPENAI_API_KEY;

export const NEON_API_KEY = alchemy.secret.env.NEON_API_KEY;

export const UPSTASH_API_KEY = alchemy.secret.env.UPSTASH_API_KEY;

export default {
  stage: process.env.BRANCH_PREFIX || "prod",
  phase:
    (process.env.ALCHEMY_PHASE as Phase) ??
    (process.argv.includes("--destroy")
      ? "destroy"
      : process.argv.includes("--read")
        ? "read"
        : "up"),
  // pass the password in (you can get it from anywhere, e.g. stdin)
  password: process.env.SECRET_PASSPHRASE,
  quiet: process.argv.includes("--quiet"),
  stateStore: (scope) => new CloudflareStateStore(scope),
} satisfies AlchemyOptions;
