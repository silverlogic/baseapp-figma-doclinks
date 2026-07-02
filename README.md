# BaseApp DocLinks (Figma plugin)

Writes canonical documentation links onto components on the current Figma page,
from a **links file you select at runtime**. The plugin carries no
project-specific data — the links file is the only interface, so the same plugin
binary works for any design system that can produce the file.

## What it writes

For each component on the current page whose name matches an entry in the links
file, the plugin populates two Figma surfaces:

- **`documentationLinks`** — the **Link** field in Design Mode's component-config
  panel. Figma caps this at one URL; the plugin uses the entry's first `uris`
  item (`uris[0]`).
- **Dev Resources** — the Dev Mode resources panel (multiple labeled links).
  The plugin adds the secondary links (`uris[1..]`); the primary URL is rendered
  there automatically by Figma, so it is deliberately not re-added.

The write loop is **idempotent, self-cleaning, and fingerprinted**: re-runs on an
up-to-date file are near-instant, and owned URLs (see `ownedUrlPatterns`) that
are no longer in an entry are removed.

## The links file

```jsonc
{
  "version": 1,
  // Optional. URL prefixes the plugin "owns" and may delete when stale.
  // Regex sources (JS string form, double-escaped). If omitted, BaseApp
  // defaults apply (storybook.baseapp.io, github silverlogic/baseapp-frontend,
  // (v*.)mui.com/material-ui|x).
  "ownedUrlPatterns": ["^https://storybook\\.baseapp\\.io/"],
  "links": [
    {
      "figmaName": "Avatar",
      "uris": [
        { "name": "MUI docs",  "url": "https://v5.mui.com/material-ui/react-avatar/" },
        { "name": "Storybook", "url": "https://storybook.baseapp.io/?path=/docs/…" },
        { "name": "Source",    "url": "https://github.com/silverlogic/…/index.tsx" }
      ]
    }
  ]
}
```

A bare top-level array (legacy format) is also accepted and treated as `links`.

This file is **generated** in the `baseapp-frontend-template` repo from the
`frontend-design-system` skill references (`primitives-web.md`,
`mui-overrides-web.md`) via `apps/figma-link-plugin/scripts/generate-link-map.mjs`.
That generator stays there because it depends on those references and the
workspace MUI version. This plugin only *consumes* its output. See
`examples/links.sample.json` for a minimal file.

## Build

```bash
pnpm install        # or npm install
pnpm build          # → dist/code.js + dist/ui.html
pnpm watch          # rebuild code.js on change (re-run to refresh ui.html)
pnpm typecheck      # tsc --noEmit
```

## Install in Figma desktop

1. Figma desktop → **Plugins → Development → Import plugin from manifest…**
2. Pick `manifest.json`.
3. The plugin appears under **Plugins → Development → BaseApp DocLinks**.

You need editor access on the target file. The plugin runs in **Design Mode**
(Dev Mode is read-only, but dev resources can still be written from Design Mode).

## Run

1. Open the target file and **navigate to the page that holds the components**
   (the plugin scans the current page only — full-file searches trigger an
   expensive server fetch on large files).
2. **Plugins → Development → BaseApp DocLinks**.
3. In the panel: **choose a `.json` file** or **paste JSON**, then **Run**. After
   the first run the file is remembered — subsequent runs are one click
   (**Run with last file**).
4. The plugin closes with a summary like
   `Linked 53/82 components. 29 Figma components have no link entry; 46 link
   entries have no matching Figma component.` The dev console holds the full
   inventory.

## Relationship to the source repo

| This repo (`baseapp-figma-doclinks`) | `baseapp-frontend-template` |
| --- | --- |
| The plugin runtime (generic, data-agnostic). Never rebuilt for a data change. | The data producer: `generate-link-map.mjs` + `check-links.mjs`, tied to the skill references. |
| Consumes a links file at runtime. | Emits the links file as an artifact. |

## What's next

- **Fetch-from-URL source** (additive): publish the links file to a stable URL
  and let the UI fetch it — add `networkAccess` to `manifest.json` and a second
  source button. The schema and message layer already support it.
- **Pages-aware matching** if components ever share names across pages.
