import { exec } from "child_process";
import fs from "fs/promises";
import { promisify } from "util";
import type { Context } from "../context";
import { Resource } from "../resource";

const execAsync = promisify(exec);

export interface VitePressProjectProps {
  /**
   * The name/path of the project
   */
  name: string;

  /**
   * The title of the documentation site
   */
  title?: string;

  /**
   * The description of the documentation site
   */
  description?: string;

  /**
   * Whether to use TypeScript for config and theme files
   * @default true
   */
  typescript?: boolean;

  /**
   * Force overwrite the project config files during the update phase
   * @default false
   */
  overwrite?: boolean;
}

export interface VitePressProject extends VitePressProjectProps, Resource {
  /**
   * The name/path of the project
   */
  name: string;
}

export const VitePressProject = Resource(
  "project::VitePressProject",
  {
    alwaysUpdate: true,
  },
  async function (
    this: Context<VitePressProject>,
    id: string,
    props: VitePressProjectProps,
  ): Promise<VitePressProject> {
    const phase = this.phase;
    if (this.phase === "delete") {
      try {
        if (await fs.exists(props.name)) {
          // Delete the entire project directory
          await execAsync(`rm -rf ${props.name}`);
        }
      } catch (error) {
        console.error(`Error deleting VitePress project ${id}:`, error);
      }
      return this.destroy();
    }

    if (this.phase === "update") {
      if (props.overwrite) {
        await modifyConfig(props);
      } else {
        console.warn(
          "VitePressProject does not support updates without overwrite: true - the project must be recreated to change the configuration",
        );
      }
    } else {
      // Create the project directory
      await fs.mkdir(props.name, { recursive: true });

      // Initialize project files
      await initializeProject(props);
    }

    return this(props);

    async function initializeProject(props: VitePressProjectProps) {
      const cwd = props.name;

      // Initialize package.json
      await fs.writeFile(
        `${cwd}/package.json`,
        JSON.stringify(
          {
            name: props.name,
            scripts: {
              "docs:dev": "vitepress dev",
              "docs:build": "vitepress build",
              "docs:preview": "vitepress preview",
            },
            devDependencies: {
              vue: "^3.5.13",
              vitepress: "^1.6.3",
            },
          },
          null,
          2,
        ),
      );

      // Create .gitignore
      await fs.writeFile(`${cwd}/.gitignore`, `.vitepress/cache\n`);

      // Create .vitepress directory and config
      await fs.mkdir(`${cwd}/.vitepress`, { recursive: true });
      await fs.writeFile(
        `${cwd}/.vitepress/config.mts`,
        `import { defineConfig } from "vitepress";

// https://vitepress.dev/reference/site-config
export default defineConfig({
  title: ${JSON.stringify(props.title || "Alchemy")},
  description: ${JSON.stringify(props.description || "Alchemy Docs")},
  themeConfig: {
    // https://vitepress.dev/reference/default-theme-config
    nav: [
      { text: "Home", link: "/" },
      { text: "Examples", link: "/markdown-examples" },
    ],

    sidebar: [
      {
        text: "Examples",
        items: [
          { text: "Markdown Examples", link: "/markdown-examples" },
          { text: "Runtime API Examples", link: "/api-examples" },
        ],
      },
    ],

    socialLinks: [
      { icon: "github", link: "https://github.com/vuejs/vitepress" },
    ],
  },
});
`,
      );

      // Create markdown files
      await fs.writeFile(
        `${cwd}/index.md`,
        `---
# https://vitepress.dev/reference/default-theme-home-page
layout: home

hero:
  name: "Alchemy"
  text: "Alchemy Docs"
  tagline: My great project tagline
  actions:
    - theme: brand
      text: Markdown Examples
      link: /markdown-examples
    - theme: alt
      text: API Examples
      link: /api-examples

features:
  - title: Feature A
    details: Lorem ipsum dolor sit amet, consectetur adipiscing elit
  - title: Feature B
    details: Lorem ipsum dolor sit amet, consectetur adipiscing elit
  - title: Feature C
    details: Lorem ipsum dolor sit amet, consectetur adipiscing elit
---
`,
      );

      await fs.writeFile(
        `${cwd}/markdown-examples.md`,
        `# Markdown Extension Examples

This page demonstrates some of the built-in markdown extensions provided by VitePress.

## Syntax Highlighting

VitePress provides Syntax Highlighting powered by [Shiki](https://github.com/shikijs/shiki), with additional features like line-highlighting:

**Input**

\`\`\`\`md
\`\`\`js{4}
export default {
  data () {
    return {
      msg: 'Highlighted!'
    }
  }
}
\`\`\`
\`\`\`\`

**Output**

\`\`\`js{4}
export default {
  data () {
    return {
      msg: 'Highlighted!'
    }
  }
}
\`\`\`

## Custom Containers

**Input**

\`\`\`md
::: info
This is an info box.
:::

::: tip
This is a tip.
:::

::: warning
This is a warning.
:::

::: danger
This is a dangerous warning.
:::

::: details
This is a details block.
:::
\`\`\`

**Output**

::: info
This is an info box.
:::

::: tip
This is a tip.
:::

::: warning
This is a warning.
:::

::: danger
This is a dangerous warning.
:::

::: details
This is a details block.
:::

## More

Check out the documentation for the [full list of markdown extensions](https://vitepress.dev/guide/markdown).
`,
      );

      await fs.writeFile(
        `${cwd}/api-examples.md`,
        `---
outline: deep
---

# Runtime API Examples

This page demonstrates usage of some of the runtime APIs provided by VitePress.

The main \`useData()\` API can be used to access site, theme, and page data for the current page. It works in both \`.md\` and \`.vue\` files:

\`\`\`md
<script setup>
import { useData } from 'vitepress'

const { theme, page, frontmatter } = useData()
</script>

## Results

### Theme Data
<pre>{{ theme }}</pre>

### Page Data
<pre>{{ page }}</pre>

### Page Frontmatter
<pre>{{ frontmatter }}</pre>
\`\`\`

<script setup>
import { useData } from 'vitepress'

const { site, theme, page, frontmatter } = useData()
</script>

## Results

### Theme Data
<pre>{{ theme }}</pre>

### Page Data
<pre>{{ page }}</pre>

### Page Frontmatter
<pre>{{ frontmatter }}</pre>

## More

Check out the documentation for the [full list of runtime APIs](https://vitepress.dev/reference/runtime-api#usedata).
`,
      );

      // Install dependencies
      await execAsync("bun install", { cwd });
    }

    async function modifyConfig(props: VitePressProjectProps) {
      const cwd = props.name;
      const configPath = `${cwd}/.vitepress/config.mts`;

      // Only modify if the file exists and we have title or description to update
      if ((await fs.exists(configPath)) && (props.title || props.description)) {
        const configContent = await fs.readFile(configPath, "utf-8");
        let updatedContent = configContent;

        if (props.title) {
          updatedContent = updatedContent.replace(
            /title:\s*['"].*?['"]/,
            `title: ${JSON.stringify(props.title)}`,
          );
        }

        if (props.description) {
          updatedContent = updatedContent.replace(
            /description:\s*['"].*?['"]/,
            `description: ${JSON.stringify(props.description)}`,
          );
        }

        await fs.writeFile(configPath, updatedContent);
      }
    }
  },
);
