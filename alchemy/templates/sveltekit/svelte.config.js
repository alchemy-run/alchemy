import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import alchemyCloudflare from 'alchemy/cloudflare/sveltekit';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: alchemyCloudflare()
  }
};

export default config;
