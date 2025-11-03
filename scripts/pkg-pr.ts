import { $ } from "bun";
import fs from "node:fs/promises";
import path from "node:path";

const packages = [
  "alchemy-effect",
  "alchemy-effect-aws",
  "alchemy-effect-cloudflare",
  "alchemy-effect-cli",
];

for (const p of packages) {
  await $.cwd(p)`bun pm pack`;
  const files = await fs.readdir(p);
  for (const f of files) {
    if (f.endsWith(".tgz")) {
      // pkg.pr-new has a dumb bug
      await fs.rename(path.join(p, f), path.join(p, `@${f}`));
    }
  }
}
await $`bunx pkg-pr-new publish --bun ./alchemy-effect ./alchemy-effect-aws ./alchemy-effect-cloudflare ./alchemy-effect-cli`;
