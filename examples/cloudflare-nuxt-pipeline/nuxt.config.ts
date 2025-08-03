// https://nuxt.com/docs/api/configuration/nuxt-config

import alchemy from "alchemy/cloudflare/nuxt";
import { defineNuxtConfig } from "nuxt/config";

export default defineNuxtConfig({
  compatibilityDate: "2025-04-21",
  devtools: { enabled: true },
  nitro: {
    preset: "cloudflare-module",
    cloudflare: alchemy(),
    prerender: {
      routes: ["/"],
      autoSubfolderIndex: false,
    },
  },
  modules: ["nitro-cloudflare-dev"],
});
