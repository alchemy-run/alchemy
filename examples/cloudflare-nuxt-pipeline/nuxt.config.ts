// https://nuxt.com/docs/api/configuration/nuxt-config

import { nitroCloudflareDev } from "alchemy/cloudflare/runtime";

export default defineNuxtConfig({
  compatibilityDate: "2025-04-21",
  devtools: { enabled: true },
  nitro: {
    preset: "cloudflare-module",
    cloudflareDev: nitroCloudflareDev(),
    prerender: {
      routes: ["/"],
      autoSubfolderIndex: false,
    },
  },
  modules: ["nitro-cloudflare-dev"],
});
