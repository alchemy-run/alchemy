import alchemy from "alchemy/cloudflare/nuxt";
import { defineNuxtConfig } from "nuxt/config";

// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  devtools: { enabled: true },
  nitro: {
    preset: "cloudflare_module",
    cloudflare: alchemy(),
  },
  modules: ["nitro-cloudflare-dev"],
});
