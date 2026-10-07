/**
 * A tab that outlives a deploy.
 *
 * Every build renames its script chunks, and the old ones are gone the moment
 * `wrangler deploy` finishes (a missing /_nuxt file answers 404). A tab loaded
 * before the deploy still asks for the old names the first time it needs code
 * it has not fetched yet: another page, a dialog, a menu. That import fails and
 * Nuxt shows its error page ("500 · Importing a module script failed" in
 * Safari, "Failed to fetch dynamically imported module" in Chrome), which
 * reads as the site being down when a reload is the whole fix.
 *
 * Nuxt reloads by itself for a failed *route* chunk, but not for a lazily
 * loaded component, which is what PrimeVue's overlays are. So this covers the
 * rest: any error that is a failed chunk import reloads the page once.
 *
 * Once, because a reload that does not help must not loop: the stamp in
 * sessionStorage lets one reload through per 30 seconds, and after that the
 * error page is shown as it would have been.
 */
const CHUNK_ERROR = /importing a module script failed|failed to fetch dynamically imported module|error loading dynamically imported module|unable to preload css/i
const STAMP = 'staleBuild.reloadedAt'

export default defineNuxtPlugin((nuxtApp) => {
  function reloadOnce(): boolean {
    try {
      const last = Number(sessionStorage.getItem(STAMP) || 0)
      if (Date.now() - last < 30_000) return false
      sessionStorage.setItem(STAMP, String(Date.now()))
    } catch {
      // No storage means no way to tell a loop from a first try. Show the error.
      return false
    }
    window.location.reload()
    return true
  }

  const check = (err: unknown) => {
    const text = err instanceof Error ? err.message : String(err ?? '')
    if (CHUNK_ERROR.test(text)) reloadOnce()
  }

  nuxtApp.hook('app:chunkError', () => { reloadOnce() })
  nuxtApp.hook('vue:error', check)
  nuxtApp.hook('app:error', check)
  // Vite's own signal for a preload that 404s, raised before any import rejects.
  window.addEventListener('vite:preloadError', () => { reloadOnce() })
  window.addEventListener('unhandledrejection', (e) => check(e.reason))
})
