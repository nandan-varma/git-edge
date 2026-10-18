# git-edge docs

The documentation site for [git-edge](../README.md), built with
[Astro](https://docs.astro.build) and [Starlight](https://starlight.astro.build).
The published site lives at https://nandan-varma.github.io/git-edge/.

Every page is Markdown or MDX under `src/content/docs/`. Starlight turns each
file into a route based on its path, so `src/content/docs/guides/repo-cache.mdx`
becomes `/git-edge/guides/repo-cache/`. The filename is the slug — if you rename
a file, update every inbound link and the sidebar entry.

The sidebar in `astro.config.mjs` lists what appears in the navigation, in
order. Add a page by creating the file and then adding its slug to the relevant
sidebar group. Internal links are checked at build time: a link to a route that
no longer exists fails `npm run build`.

Static files, such as the favicon, go in `public/`. Shared layout and theme
tweaks go in `src/styles/custom.css`; repeatable API blocks are components under
`src/components/`.

## Commands

Run these from `docs/`:

| Command | Action |
| --- | --- |
| `npm install` | Install dependencies. |
| `npm run dev` | Start the dev server at http://localhost:4321. |
| `npm run build` | Build the production site to `./dist/`. |
| `npm run preview` | Serve the built site locally. |
| `npm run astro ...` | Run Astro CLI commands such as `astro check`. |

The build fails on broken internal links, so run `npm run build` before you
commit a page change.
