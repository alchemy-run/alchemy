import cloudflare from '@astrojs/cloudflare';
import { getPlatformProxyOptions } from 'alchemy/cloudflare/runtime';
import { defineConfig } from 'astro/config';

// https://astro.build/config
export default defineConfig({
  output: 'server',
  adapter: cloudflare({
    platformProxy: getPlatformProxyOptions(),
  }),
});