import TwoslashFloatingVue from "@shikijs/vitepress-twoslash/client";
import "@shikijs/vitepress-twoslash/style.css";
import type { Theme as ThemeConfig } from "vitepress";
import Theme from "vitepress/theme-without-fonts";
import "./style.css";

export default {
  extends: Theme,
  enhanceApp(ctx) {
    ctx.app.use(TwoslashFloatingVue);
  },
} satisfies ThemeConfig;
