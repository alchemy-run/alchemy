# Static Astro File

The Static Astro File resource lets you create [Astro component files](https://docs.astro.build/en/core-concepts/astro-components/) in your project.

# Minimal Example

Creates a basic Astro component file.

```ts
import { StaticAstroFile } from "alchemy/fs";

const component = await StaticAstroFile("Header.astro", `
---
const title = "My Site";
---

<header>
  <h1>{title}</h1>
</header>
`);
```

# Create with Path and Content

```ts
import { StaticAstroFile } from "alchemy/fs";

const header = await StaticAstroFile("components/Header.astro", 
  `---
  import Logo from '../components/Logo.astro';
  const navItems = ['Home', 'About', 'Contact'];
  ---

  <header class="header">
    <Logo />
    <nav>
      <ul>
        {navItems.map(item => (
          <li><a href={`/${item.toLowerCase()}`}>{item}</a></li>
        ))}
      </ul>
    </nav>
  </header>

  <style>
    .header {
      display: flex;
      justify-content: space-between;
      padding: 1rem;
    }
  </style>`
);
```