# AstroFile

The AstroFile resource lets you generate [Astro](https://astro.build) components and pages using AI models.

# Minimal Example

Create a simple Astro component with basic content.

```ts
import { AstroFile } from "alchemy/ai";

const header = await AstroFile("header", {
  path: "./src/components/Header.astro",
  prompt: "Generate an Astro header component with a logo and navigation menu"
});
```

# Create a Complex Component

Generate an Astro component with data fetching and dynamic content.

```ts
import { AstroFile } from "alchemy/ai";

const blogPost = await AstroFile("blog-post", {
  path: "./src/pages/blog/[slug].astro",
  prompt: await alchemy`
    Create an Astro blog post page that:
    - Uses getStaticPaths to generate pages from a CMS
    - Renders markdown content
    - Includes author info and publication date
    
    Use these types:
    ${alchemy.file("src/types/Blog.ts")}
  `,
  temperature: 0.2,
  prettierConfig: {
    semi: false,
    singleQuote: true
  }
});
```