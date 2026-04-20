# Website UI kit — alchemy.run marketing

A pixel-accurate recreation of the alchemy.run marketing site (Astro + Starlight), reduced to reusable React components.

Open `index.html` in a browser to see the full landing page: hero, feature grid, terminal demo, provider cards, and CTA section.

## Components

- `Nav.jsx` — fixed top nav with wordmark, doc links, GitHub
- `Hero.jsx` — "Infrastructure as **Effects**" headline + primary/secondary CTAs + tagline
- `HeroCode.jsx` — side-by-side explainer + code block
- `FeatureGrid.jsx` — 6-up grid of feature + snippet pairs
- `Terminal.jsx` — CLI output widget with `[g][b][d][u][c]` markup
- `CodeBlock.jsx` — github-dark-dimmed block with filename header + diff tints
- `ProviderCards.jsx` — 3-up Cloudflare / AWS / More grid
- `CTA.jsx` — bottom section with tutorial link
- `Button.jsx` — primary / secondary / ghost variants, matches Starlight's `<LinkButton />`
- `Footer.jsx` — minimal hairline footer

## Notes

- Dark mode only — never render light variants.
- All text uses sentence case; product name **alchemy** stays lowercase.
- The hero headline "**Effects**" is the only place that uses the white → mint text gradient.
- Hover on any card: border becomes `var(--alc-accent)`. No translate, no scale.
