// Auto-imported across the app (Nuxt scans app/utils). Shared by every chart
// component for tooltip HTML + percentage formatting.

/** Escape user text before it goes into a v-html tooltip string. */
export function esc(s: unknown): string {
  return String(s).replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string,
  )
}

/** part/whole as a percent, one decimal below 10% (matches the original). */
export function pct(part: number, whole: number): string {
  if (!whole) return '0%'
  const p = (part / whole) * 100
  return (p >= 10 ? Math.round(p) : Math.round(p * 10) / 10) + '%'
}

/** Compact annual salary, e.g. 145000 → "$145k". 0/falsy → "—". */
export function money(n: number): string {
  if (!n) return '—'
  return '$' + Math.round(n / 1000) + 'k'
}
