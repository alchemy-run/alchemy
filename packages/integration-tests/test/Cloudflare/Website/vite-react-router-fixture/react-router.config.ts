import type { Config } from "@react-router/dev/config";

export default {
  // Config options...
  // Server-side render by default, to enable SPA mode set this to `false`
  ssr: true,
  // React Router 8's default, which a C3 project gets implicitly; the React
  // Router 7 pinned here needs it to run the `ssr` environment in workerd.
  future: { v8_viteEnvironmentApi: true },
} satisfies Config;
