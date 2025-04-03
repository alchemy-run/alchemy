# Astro File

The AstroFile resource lets you generate [Astro](https://astro.build) components and pages using AI models.

# Minimal Example

Creates a basic Astro component with AI-generated content.

```ts
import { AstroFile } from "alchemy/ai";

const header = await AstroFile("header", {
  path: "./src/components/Header.astro",
  prompt: "Generate a simple header component with a logo and navigation menu"
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
    - Includes author info and publication date
    - Has social sharing buttons

    Use the following types:
    ${alchemy.file("src/types/Blog.ts")}
  `,
  temperature: 0.2,
  prettierConfig: {
    semi: false,
    singleQuote: true,
    printWidth: 120
  }
});
```