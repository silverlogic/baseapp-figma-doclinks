# Cutover patch — apply when this repo goes live

> **Do not apply any of this until `baseapp-figma-doclinks` is pushed and the plugin
> is re-imported in Figma from the new repo's `manifest.json`.** Until then the
> template's bundled plugin (`apps/figma-link-plugin`) is still the working
> truth and these edits would describe a workflow that doesn't exist yet.

All paths below are in **`baseapp-frontend-template`**. After applying, delete this file.

Decision baked into this patch: the template package **keeps its name and path**
(`@baseapp/figma-link-plugin`, `apps/figma-link-plugin/`) and becomes a
**data producer** — it keeps `scripts/generate-link-map.mjs`, `scripts/check-links.mjs`,
and the generated `src/links.json` artifact, and loses the plugin runtime. This
keeps every `pnpm --filter @baseapp/figma-link-plugin generate|check-links`
command in the docs valid, so only the `build`/"rebundle"/"run bundled plugin"
steps change. (Renaming the dir/package is optional and noted at the end.)

The one new workflow step everywhere: instead of `build` → run, it's now
**run the DocLinks plugin in Figma and select `apps/figma-link-plugin/src/links.json`
(or "Run with last file")**.

---

## 1. Slim the template plugin → data producer

**Delete** (runtime-only, now lives in `baseapp-figma-doclinks`):

```
apps/figma-link-plugin/src/code.ts
apps/figma-link-plugin/manifest.json
apps/figma-link-plugin/tsconfig.json
apps/figma-link-plugin/.eslintrc.js
apps/figma-link-plugin/dist/          # gitignored; remove if present
```

**Keep:** `scripts/generate-link-map.mjs`, `scripts/check-links.mjs`,
`src/links.json` (the committed artifact), `.gitignore`.

**`apps/figma-link-plugin/package.json`** — drop the build pipeline:

```jsonc
{
  "name": "@baseapp/figma-link-plugin",
  "private": true,
  "version": "0.0.1",
  "description": "Generates the DocLinks links.json artifact from the design-system skill references. The plugin that consumes it lives in the baseapp-figma-doclinks repo.",
  "scripts": {
    "generate": "node scripts/generate-link-map.mjs",
    "check-links": "node scripts/check-links.mjs"
    // removed: "build", "watch"
  },
  "devDependencies": {}
  // removed: "@figma/plugin-typings", "esbuild", "typescript"
}
```

**`apps/figma-link-plugin/README.md`** — replace the build/install/run sections
with a short "data producer" note: this package only generates `src/links.json`;
to update Figma, regenerate then run the plugin from `baseapp-figma-doclinks` and
select the file. Point to `../../../baseapp-figma-doclinks/README.md` for the plugin.

---

## 2. `references/code-connect.md`

**Line 14 — Mechanism.** Replace:

> **Mechanism.** A Figma plugin at [`apps/figma-link-plugin/`](../../../apps/figma-link-plugin/) walks the current page's `COMPONENT` / `COMPONENT_SET` nodes, matches them by name against `src/links.json`, and writes both surfaces.

with:

> **Mechanism.** A Figma plugin (repo: `baseapp-figma-doclinks`, installed separately in Figma desktop) walks the current page's `COMPONENT` / `COMPONENT_SET` nodes, matches them by name against a **links file selected at runtime**, and writes both surfaces. That file is generated here — see *Source of truth*. The plugin is data-agnostic: it is **not** rebuilt when the link map changes.

**Line 16 — Source of truth.** Replace the trailing sentence:

> …by `apps/figma-link-plugin/scripts/generate-link-map.mjs`. Don't hand-edit `links.json`.

with:

> …by `apps/figma-link-plugin/scripts/generate-link-map.mjs`, which emits `apps/figma-link-plugin/src/links.json` (a `{ version, ownedUrlPatterns, links }` payload). This is the artifact you select in the plugin. Don't hand-edit it.

**Line 36 — Self-cleaning.** Append one sentence:

> The owned-URL patterns now travel inside the links file (`ownedUrlPatterns`), so the plugin holds no hardcoded URLs.

**§ Process for adding a new component — replace steps 2–6:**

```
2. Run `pnpm --filter @baseapp/figma-link-plugin generate` to regenerate `src/links.json`.
3. Run `pnpm --filter @baseapp/figma-link-plugin check-links` to verify every URL still 200s (recommended when adding rows or after a MUI major bump).
4. In Figma desktop, navigate to the **Components** page of the target file (the plugin scopes to the current page), then run **Plugins → Development → BaseApp DocLinks**.
5. In the plugin panel, **select `apps/figma-link-plugin/src/links.json`** — or click **Run with last file** if the location is unchanged from a previous run.
6. Verify the summary toast (`Linked N/M components. X without entry; Y unmatched.`) and check the console inventory for `✓` next to the new component name.
```

(Old step 4 — `build` to rebundle — is removed: there is no rebuild for data changes.)

**§ Recovering from broken URLs** — unchanged (the generator + its override tables stay in the template).

---

## 3. `frontend-design-system/SKILL.md`

**Frontmatter, lines 11–13** — replace:

> …or working on the BaseApp DocLinks plugin — edits to `primitives-web.md` or `mui-overrides-web.md` propagate to the plugin via the generator at `apps/figma-link-plugin/scripts/generate-link-map.mjs`.

with:

> …or maintaining the BaseApp DocLinks link map — edits to `primitives-web.md` or `mui-overrides-web.md` are compiled into the links file by the generator at `apps/figma-link-plugin/scripts/generate-link-map.mjs`, which the (separately-housed) DocLinks plugin consumes at runtime.

**Line 30** — change "the DocLinks plugin re-reads §1.2 / §1.3 on every generator run" to **"the generator re-reads §1.2 / §1.3 on every run"** (the plugin reads the produced file, not the references).

**Line 67 — Generator coupling.** Replace:

> After editing, regenerate and rebuild the plugin (see `references/code-connect.md`).

with:

> After editing, regenerate the links file (see `references/code-connect.md`); the plugin reads it at runtime — no rebuild needed.

**Lines 75–76 — Maintenance loop table.** Replace the "Then" cell for both
*New DS primitive* and *New themed MUI component* rows:

```
Run `pnpm --filter @baseapp/figma-link-plugin generate` → `check-links` (recommended) → in Figma **Design Mode** run the DocLinks plugin and **select the regenerated `src/links.json`** (Dev Mode is read-only)
```

(Drop `→ build` from both rows.)

---

## 4. `references/naming.md` (line 22)

The quoted run-log string changed. Replace:

> `[DocLinks] unmatched (links.json entry, no Figma node by that name): ...`

with:

> `[DocLinks] unmatched (links entry, no Figma node by that name): ...`

---

## 5. `AGENTS-DEVELOPMENT.md` (Design system contributions, lines 94–99)

Replace the bash block:

```bash
pnpm --filter @baseapp/figma-link-plugin generate   # rewrites links.json from the references
pnpm --filter @baseapp/figma-link-plugin build      # rebundles the plugin
```

with:

```bash
pnpm --filter @baseapp/figma-link-plugin generate     # rewrites src/links.json from the references
pnpm --filter @baseapp/figma-link-plugin check-links  # verify URLs (recommended)
# no build step — the DocLinks plugin reads links.json at runtime
```

And the following sentence — replace the run instruction + README link:

> Then run **Plugins → Development → BaseApp DocLinks** in Figma desktop on the BaseApp – WEB file (requires editor access; ask a designer if you don't have it). Full process and conventions: [`code-connect.md`](.claude/skills/frontend-design-system/references/code-connect.md) and [`apps/figma-link-plugin/README.md`](apps/figma-link-plugin/README.md).

with:

> Then run **Plugins → Development → BaseApp DocLinks** in Figma desktop on the BaseApp – WEB file and **select `apps/figma-link-plugin/src/links.json`** (or "Run with last file"). Requires editor access; ask a designer if you don't have it. Full process: [`code-connect.md`](.claude/skills/frontend-design-system/references/code-connect.md). Plugin install/build: the `baseapp-figma-doclinks` repo README.

(Line 37 "Reading the Documentation block" and its table are **unchanged** — the
written Figma surfaces are identical.)

---

## 6. Follow-ups (separate from the doc edits)

- **Re-baseline the skill evals.** `frontend-design-system/evals/evals.json` and
  `evals/trigger-evals.json`, plus the recorded snapshots under
  `frontend-design-system-workspace/iteration-1/`, encode the old `build`-then-run
  flow as expected output (notably `eval-2-add-mui-override` and `eval-3-mui-v6-bump`).
  Re-run the evals to regenerate baselines — don't hand-edit the recorded responses.
- **`.claude/settings.local.json`** (gitignored) has a permission entry for
  `pnpm --filter @baseapp/figma-link-plugin build` — now dead. Remove if you like.

## Optional: rename the template package

If you'd rather the data-producer package not read like a plugin
(`@baseapp/figma-link-plugin` → e.g. `@baseapp/figma-doclinks-data`, dir
`apps/figma-link-plugin/` → `apps/figma-doclinks-data/`): keep the
`apps/<name>/scripts/` depth so the generator's `REPO_ROOT` (`../../..`) still
resolves. This cascades into every `pnpm --filter @baseapp/figma-link-plugin …`
string in the docs above, so do it as its own pass if at all.
