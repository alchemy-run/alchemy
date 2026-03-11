import * as Build from "alchemy-effect/Build";
import * as Cloudflare from "alchemy-effect/Cloudflare";
import * as Stack from "alchemy-effect/Stack";
import * as Effect from "effect/Effect";

const stack = Effect.gen(function* () {
  const build = yield* Build.Build("vite-build", {
    command: "bun run build",
    include: ["src/**/*.ts", "index.html", "package.json", "vite.config.ts"],
    output: "dist",
  });

  const worker = yield* Cloudflare.Worker("site", {
    main: "./src/worker.ts",
    assets: build,
  });

  return {
    url: worker.url,
    buildHash: build.hash,
  };
}).pipe(Stack.make("CloudflareVite", Cloudflare.providers()));

export default stack;
