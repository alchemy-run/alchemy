import alchemy from "alchemy/cloudflare/nuxt";
import { defineNuxtConfig } from "nuxt/config";

// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: "2025-07-26",
  devtools: { enabled: true },
  nitro: {
    preset: "cloudflare_module",
    cloudflare: alchemy(),
  },
  modules: ["nitro-cloudflare-dev"],
});
