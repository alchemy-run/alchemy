# StaticAstroFile

The StaticAstroFile resource creates [Astro component files](https://docs.astro.build/en/core-concepts/astro-components/) with proper formatting and directory structure.

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

# Component with Props and Styles

Creates an Astro component with props, imports and scoped styles.

```ts
import { StaticAstroFile } from "alchemy/fs";

const header = await StaticAstroFile("Header.astro", `
---
import Logo from '../components/Logo.astro';

interface Props {
  navItems: string[];
}

const { navItems } = Astro.props;
---

<header class="header">
  <Logo />
  <nav>
    <ul>
      {navItems.map(item => (
        <li><a href={\`/\${item.toLowerCase()}\`}>{item}</a></li>
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
</style>
`);
```

# Custom Path

Creates an Astro component at a specific path.

```ts
import { StaticAstroFile } from "alchemy/fs";

const page = await StaticAstroFile("index", 
  "src/pages/index.astro",
  `---
const greeting = "Hello World";
---

<h1>{greeting}</h1>
`);
```