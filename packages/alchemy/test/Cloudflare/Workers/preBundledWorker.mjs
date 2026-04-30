// SENTINEL: alchemy-bundle-false-test 7f1c
//
// This file is intentionally a hand-written ESM bundle (no bundler step).
// It is deployed via `Cloudflare.Worker({ main, bundle: false })` and
// MUST be uploaded byte-for-byte. Rolldown minification would strip
// these comments and likely rename `kSentinel`, both of which the
// accompanying test asserts against.
const kSentinel = "alchemy-bundle-false-test/7f1c";
export default {
  async fetch() {
    return new Response(kSentinel, {
      headers: { "x-alchemy-sentinel": kSentinel },
    });
  },
};
