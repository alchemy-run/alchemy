# Astro File

The AstroFile component allows you to generate and manage [Astro](https://astro.build/) files using AI models. It supports creating, updating, and deleting Astro files with content generated based on specified prompts.

# Minimal Example

```ts
import { AstroFile } from "alchemy/ai";

const header = await AstroFile("header", {
  path: "./src/components/Header.astro",
  prompt: "Generate a simple header component with a logo and navigation links.",
});
```

# Create the Astro File

```ts
import { AstroFile } from "alchemy/ai";

const blogPost = await AstroFile("blog-post", {
  path: "./src/pages/blog/[slug].astro",
  prompt: await alchemy`
    Create an Astro blog post page that:
    - Uses getStaticPaths to generate pages from a CMS
    - Renders markdown content
    - Includes author info, publication date, and related posts
    - Has social sharing buttons
  `,
  model: {
    id: "gpt-4o",
    provider: "openai"
  }
});
```