import alchemy from "alchemy";
import { Nextjs } from "alchemy/cloudflare";

const app = await alchemy("cloudflare-nextjs");

export const website = await Nextjs("website");

await app.finalize();
