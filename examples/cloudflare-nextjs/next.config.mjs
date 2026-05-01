import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  // OpenNext on Cloudflare serves static-asset images directly, so disable
  // Next's runtime image optimizer (which needs a Sharp install on the
  // worker that we don't ship).
  images: {
    unoptimized: true,
  },
};

export default config;

initOpenNextCloudflareForDev();
