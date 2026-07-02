// BaseApp DocLinks — writes the canonical doc links for components on the
// current Figma page from a links file the user selects at runtime.
//
// For each matched component the plugin populates two surfaces:
//   • documentationLinks — the "Link" field in Design Mode's component config
//     (Figma caps this at one URL; we use uris[0]).
//   • Dev Resources — the Dev Mode panel (multiple labeled links; uris[1..]).
//
// The plugin holds NO project-specific data. The links file is the only
// interface: it is chosen via the UI (file picker / paste), validated, applied,
// and remembered in clientStorage so subsequent runs are one click.
//
// Links file schema (v1):
//   {
//     "version": 1,
//     "ownedUrlPatterns": ["^https://…", …],   // optional; see below
//     "links": [ { "figmaName": "Avatar", "uris": [ { "name": "MUI docs", "url": "…" }, … ] }, … ]
//   }
// A bare array (legacy) is also accepted and treated as { links: [...] }.

type DevResourceEntry = { name: string; url: string }
type LinkEntry = { figmaName: string; uris: DevResourceEntry[] }
type LinksPayload = {
  version: number
  ownedUrlPatterns?: string[]
  links: LinkEntry[]
}

// clientStorage key holding the last successfully-applied payload, so the UI
// can offer a one-click re-run. Bumped if the payload shape changes.
const STORAGE_KEY = 'doclinks.payload.v1'

// Per-node plugin data key holding a fingerprint of the last applied entry.
// On re-runs, nodes whose fingerprint matches skip all API calls — this keeps
// re-runs on an up-to-date file near-instant.
const FINGERPRINT_KEY = 'doclinks_fingerprint_v1'

const SUPPORTED_VERSION = 1

// Fallback owned-URL patterns, used only when a links file omits
// `ownedUrlPatterns` (e.g. a legacy bare-array file). These mirror the BaseApp
// generator's output. Any dev resource matching one of these is presumed
// plugin-written: if it's no longer in the current entry, it's stale and gets
// removed. User-added resources pointing elsewhere are never touched.
const DEFAULT_OWNED_URL_PATTERNS = [
  '^https://storybook\\.baseapp\\.io/',
  '^https://github\\.com/silverlogic/baseapp-frontend/',
  '^https://(v\\d+\\.)?mui\\.com/(material-ui|x)/',
]

// ----------------------------------------------------------------------------
// Validation — runtime input is untrusted, so normalize defensively and throw
// human-readable errors the UI surfaces verbatim.
// ----------------------------------------------------------------------------

function normalizePayload(raw: unknown): LinksPayload {
  const obj: unknown = Array.isArray(raw) ? { links: raw } : raw
  if (!obj || typeof obj !== 'object') {
    throw new Error('Links file must be a JSON object or array.')
  }
  const { version, ownedUrlPatterns, links } = obj as Record<string, unknown>

  if (version !== undefined && version !== SUPPORTED_VERSION) {
    throw new Error(
      `Unsupported links file version ${String(version)} (this plugin supports ${SUPPORTED_VERSION}).`,
    )
  }
  if (!Array.isArray(links)) {
    throw new Error('Links file is missing a top-level `links` array.')
  }

  const cleanLinks: LinkEntry[] = links.map((entry, i) => {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`links[${i}] is not an object.`)
    }
    const { figmaName, uris } = entry as Record<string, unknown>
    if (typeof figmaName !== 'string' || !figmaName) {
      throw new Error(`links[${i}].figmaName must be a non-empty string.`)
    }
    if (!Array.isArray(uris)) {
      throw new Error(`links[${i}].uris must be an array.`)
    }
    const cleanUris: DevResourceEntry[] = uris.map((u, j) => {
      if (!u || typeof u !== 'object') {
        throw new Error(`links[${i}].uris[${j}] is not an object.`)
      }
      const { name, url } = u as Record<string, unknown>
      if (typeof name !== 'string' || typeof url !== 'string') {
        throw new Error(`links[${i}].uris[${j}] must have string \`name\` and \`url\`.`)
      }
      return { name, url }
    })
    return { figmaName, uris: cleanUris }
  })

  let patterns: string[] | undefined
  if (ownedUrlPatterns !== undefined) {
    if (
      !Array.isArray(ownedUrlPatterns) ||
      ownedUrlPatterns.some((p) => typeof p !== 'string')
    ) {
      throw new Error('`ownedUrlPatterns` must be an array of strings.')
    }
    patterns = ownedUrlPatterns as string[]
  }

  return { version: SUPPORTED_VERSION, ownedUrlPatterns: patterns, links: cleanLinks }
}

function compileOwnedPatterns(sources: string[]): RegExp[] {
  const out: RegExp[] = []
  for (const s of sources) {
    try {
      out.push(new RegExp(s))
    } catch (err) {
      console.warn(`[DocLinks] invalid ownedUrlPattern skipped: "${s}"`, err)
    }
  }
  return out
}

// ----------------------------------------------------------------------------
// Apply — the core write loop. Identical behaviour to the bundled-JSON version,
// but the links and owned-URL patterns are passed in rather than imported.
// ----------------------------------------------------------------------------

type Result = {
  matched: string[]
  unmatched: string[]
  figmaWithoutEntry: { name: string; isSet: boolean }[]
  totalComponents: number
}

const fingerprintFor = (entry: LinkEntry): string =>
  entry.uris.map((u) => `${u.name}=${u.url}`).join('|')

async function applyLinks(payload: LinksPayload): Promise<Result> {
  const links = payload.links
  const ownedPatterns = compileOwnedPatterns(
    payload.ownedUrlPatterns ?? DEFAULT_OWNED_URL_PATTERNS,
  )
  const isOwnedUrl = (url: string): boolean =>
    ownedPatterns.some((p) => p.test(url))

  // Scope to the current page. DS files keep all components on one page; a
  // current-page search avoids the multi-second server fetch that
  // loadAllPagesAsync() triggers on big files.
  //
  // Filter out variant children of Component Sets: findAllWithCriteria returns
  // every COMPONENT node, including variants nested inside a SET (names like
  // "Variant=Outlined, …"). The parent SET carries documentationLinks for the
  // family, so the variants are noise here.
  const allMatchingNodes = figma.currentPage.findAllWithCriteria({
    types: ['COMPONENT', 'COMPONENT_SET'],
  })
  const components = allMatchingNodes.filter(
    (c) => c.type === 'COMPONENT_SET' || c.parent?.type !== 'COMPONENT_SET',
  )
  const variantsSkipped = allMatchingNodes.length - components.length

  console.log(
    `[DocLinks] page="${figma.currentPage.name}" components=${components.length} ` +
      `(${variantsSkipped} variant children of Component Sets skipped)`,
  )

  const matched: string[] = []
  const unmatched: string[] = []
  const skippedFastPath: string[] = []
  const matchedFigmaNodeNames = new Set<string>()

  // Per-component task. Sync work (documentationLinks, fingerprint check,
  // setPluginData) happens inline; async dev-resource work is wrapped in a
  // promise so all components run in parallel via Promise.all below.
  const tasks: Array<Promise<void>> = []

  for (const entry of links) {
    const node = components.find((n) => n.name === entry.figmaName)
    if (!node) {
      unmatched.push(entry.figmaName)
      continue
    }

    // Bind the primary URI up front: the guard narrows it from
    // `DevResourceEntry | undefined` to a value, so its `.url` is safe below.
    const [primaryUri, ...devResourceUris] = entry.uris
    if (!primaryUri) continue

    matched.push(entry.figmaName)
    matchedFigmaNodeNames.add(node.name)

    // Fast path: if the last successful run wrote exactly this entry's content
    // to this node, skip all API work. The fingerprint lives in plugin data
    // on the node itself.
    const fingerprint = fingerprintFor(entry)
    if (node.getPluginData(FINGERPRINT_KEY) === fingerprint) {
      skippedFastPath.push(entry.figmaName)
      continue
    }

    // 1) Designer-facing single link via documentationLinks (Component-config
    // Link field, regular Figma + Dev Mode). Figma caps this array at 1 at
    // runtime. Setter is sync — no round-trip.
    node.documentationLinks = [{ uri: primaryUri.url }]

    // 2) Dev-facing labeled links via Dev Resources (Dev Mode panel, no limit).
    // We deliberately SKIP uris[0]: Figma's Dev Mode renders the
    // documentationLinks URL in the same panel automatically (auto-labeled),
    // so re-adding it as an explicit dev resource creates a visible duplicate.
    // Only secondary links (uris[1..], already destructured above) become
    // explicit dev resources.
    //
    // Idempotent + self-cleaning:
    //   - Delete any owned URL on the node that's not in our current set
    //     (catches URL drift across versions and removes the primary if a
    //     previous run added it as a dev resource).
    //   - Edit existing entries to refresh labels; add missing ones.
    // User-added resources outside the owned patterns are never touched.
    // Wrapped in try so files without Dev Mode access still get the
    // documentationLinks update.
    tasks.push(
      (async () => {
        try {
          const existing = await node.getDevResourcesAsync()
          const newUrls = new Set(devResourceUris.map((u) => u.url))

          for (const r of existing) {
            if (isOwnedUrl(r.url) && !newUrls.has(r.url)) {
              await node.deleteDevResourceAsync(r.url)
            }
          }

          const existingByUrl = new Map(existing.map((r) => [r.url, r]))
          for (const { name, url } of devResourceUris) {
            const existingResource = existingByUrl.get(url)
            if (existingResource) {
              // Skip edit if the name is already correct — Figma's
              // editDevResourceAsync throws "Nothing Changed" on no-op edits.
              if (existingResource.name !== name) {
                await node.editDevResourceAsync(url, { name })
              }
            } else {
              await node.addDevResourceAsync(url, name)
            }
          }

          // Persist the fingerprint only after all dev-resource ops succeeded —
          // partial failures re-process next run rather than silently skipping.
          node.setPluginData(FINGERPRINT_KEY, fingerprint)
        } catch (err) {
          console.warn(
            `[DocLinks] dev resources unavailable for "${entry.figmaName}":`,
            err,
          )
        }
      })(),
    )
  }

  await Promise.all(tasks)

  if (skippedFastPath.length) {
    console.log(
      `[DocLinks] fast-path: ${skippedFastPath.length} components skipped (fingerprint unchanged since last run)`,
    )
  }

  // Inventory of every component on the page — useful for auditing the links
  // file against the canonical Figma file.
  const figmaWithoutEntry: { name: string; isSet: boolean }[] = []
  console.log('[DocLinks] full inventory (CMP=COMPONENT, SET=COMPONENT_SET, ✓=linked):')
  for (const c of components) {
    const isSet = c.type === 'COMPONENT_SET'
    const linked = matchedFigmaNodeNames.has(c.name)
    console.log(`  ${isSet ? 'SET' : 'CMP'}  ${linked ? '✓' : '·'}  ${c.name}`)
    if (!linked) figmaWithoutEntry.push({ name: c.name, isSet })
  }

  return { matched, unmatched, figmaWithoutEntry, totalComponents: components.length }
}

function formatSummary(r: Result): string {
  return (
    `Linked ${r.matched.length}/${r.totalComponents} components. ` +
    `${r.figmaWithoutEntry.length} Figma components have no link entry; ` +
    `${r.unmatched.length} link entries have no matching Figma component.`
  )
}

async function run(payload: LinksPayload): Promise<void> {
  figma.notify('Running BaseApp DocLinks…')
  console.log('[DocLinks] starting')
  // Yield one tick so Figma renders the toast before the sync findAll + writes.
  await new Promise<void>((resolve) => setTimeout(resolve, 0))

  const result = await applyLinks(payload)
  console.log('[DocLinks] matched (links → Figma):', result.matched)
  console.log(
    '[DocLinks] unmatched (links entry, no Figma node by that name):',
    result.unmatched,
  )
  console.log(
    '[DocLinks] Figma components with no link entry (audit target):',
    result.figmaWithoutEntry.map((c) => `${c.isSet ? 'SET ' : 'CMP '}${c.name}`),
  )
  figma.closePlugin(formatSummary(result))
}

// ----------------------------------------------------------------------------
// UI bootstrap + message handling.
// ----------------------------------------------------------------------------

type UiMessage =
  | { type: 'request-init' }
  | { type: 'run'; payload: unknown }
  | { type: 'run-remembered' }
  | { type: 'cancel' }

figma.showUI(__html__, { width: 380, height: 460, themeColors: true })

figma.ui.onmessage = async (msg: UiMessage): Promise<void> => {
  try {
    if (msg.type === 'cancel') {
      figma.closePlugin()
      return
    }

    if (msg.type === 'request-init') {
      const stored = (await figma.clientStorage.getAsync(STORAGE_KEY)) as
        | LinksPayload
        | undefined
      figma.ui.postMessage({
        type: 'init',
        remembered: stored ? { count: stored.links.length } : null,
      })
      return
    }

    if (msg.type === 'run-remembered') {
      const stored = (await figma.clientStorage.getAsync(STORAGE_KEY)) as
        | LinksPayload
        | undefined
      if (!stored) {
        throw new Error('No remembered links file — choose or paste one first.')
      }
      await run(stored)
      return
    }

    if (msg.type === 'run') {
      const payload = normalizePayload(msg.payload)
      await figma.clientStorage.setAsync(STORAGE_KEY, payload)
      await run(payload)
      return
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[DocLinks] error:', err)
    // Keep the UI open so the user can fix the input and retry.
    figma.ui.postMessage({ type: 'error', message })
  }
}
