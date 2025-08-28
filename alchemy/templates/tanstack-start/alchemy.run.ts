/// <reference types="@types/node" />

import alchemy from "alchemy";
import { TanStackStart } from "alchemy/cloudflare";

const app = await alchemy("{projectName}");

export const worker = await TanStackStart("website");

console.log({
  url: worker.url,
});

await app.finalize();
