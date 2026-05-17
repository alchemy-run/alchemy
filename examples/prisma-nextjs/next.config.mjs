/** @type {import("next").NextConfig} */
const nextConfig = {
  // Prisma Compute's Next.js auto-build strategy uploads `.next/standalone`.
  // Without this setting, `next build` only creates the default `.next` output
  // and Alchemy will fail fast with a clear standalone-output error.
  output: "standalone",
};

export default nextConfig;
