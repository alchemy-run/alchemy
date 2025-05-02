import path from "node:path";
import type { DefaultTheme, HeadConfig, ThemeOptions } from "vitepress";
import { StaticTypeScriptFile } from "../../fs/static-typescript-file.js";

export type VitePressConfigProps = {
  cwd: string;
  title?: string;
  description?: string;
  head?: HeadConfig[];
  theme?: ThemeOptions;
  themeConfig: DefaultTheme.Config;
};

export type VitePressConfig = Awaited<ReturnType<typeof VitePressConfig>>;

export function VitePressConfig(props: VitePressConfigProps) {
  return StaticTypeScriptFile(
    path.join(props.cwd, ".vitepress", "config.mts"),
    `import { transformerTwoslash } from "@shikijs/vitepress-twoslash";
import footnotePlugin from "markdown-it-footnote";
import { defineConfig } from "vitepress";

// https://vitepress.dev/reference/site-config
export default defineConfig({
  title: ${JSON.stringify(props.title || "Alchemy")},
  description: ${JSON.stringify(props.description || "Alchemy Docs")},
  head: ${JSON.stringify(props.head || [])},
  markdown: {
    // @ts-ignore
    codeTransformers: [transformerTwoslash()],
    theme: ${JSON.stringify(
      props.theme ?? {
        light: "light-plus",
        dark: "dark-plus",
      },
    )},
    config: (md) => md.use(footnotePlugin),
  },
  // https://vitepress.dev/reference/default-theme-config
  themeConfig: ${JSON.stringify({
    ...props.themeConfig,
    search: props.themeConfig.search ?? { provider: "local" },
    nav: props.themeConfig.nav ?? [{ text: "Home", link: "/" }],
    sidebar: props.themeConfig.sidebar ?? [],
    socialLinks: props.themeConfig.socialLinks ?? [],
  })}
});
`,
  );
}
