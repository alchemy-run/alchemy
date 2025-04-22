import alchemy from "../alchemy/src";
import type { AlchemyOptions } from "../alchemy/src/alchemy";

export const CLOUDFLARE_EMAIL = await alchemy.env.CLOUDFLARE_EMAIL;

export const CLOUDFLARE_ACCOUNT_ID = await alchemy.env.CLOUDFLARE_ACCOUNT_ID;

export const CLOUDFLARE_API_KEY = await alchemy.secret.env.CLOUDFLARE_API_KEY;

export const STRIPE_API_KEY = await alchemy.secret.env.STRIPE_API_KEY;

export const OPENAI_API_KEY = await alchemy.secret.env.OPENAI_API_KEY;

export default {
  stage: "prod",
  phase: process.argv.includes("--destroy") ? "destroy" : "up",
  // pass the password in (you can get it from anywhere, e.g. stdin)
  password: process.env.SECRET_PASSPHRASE,
  quiet: process.argv.includes("--quiet"),
} satisfies AlchemyOptions;
