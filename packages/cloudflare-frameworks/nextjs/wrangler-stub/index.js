// This is a stub. @alchemy.run/cloudflare-frameworks/nextjs is wrangler-free by design: only
// wrangler's package.json (the version field) is ever read, by
// @opennextjs/cloudflare's `ensureNextjsVersionSupported`. No wrangler code
// may run on the build path — fail loudly if anything tries.
throw new Error(
  "wrangler is stubbed out by @alchemy.run/cloudflare-frameworks/nextjs: the OpenNext build path must never execute wrangler code.",
);
