<script setup lang="ts">
import { computed } from 'vue'
import { sankey as d3sankey, sankeyLinkHorizontal } from 'd3-sankey'
import type { Stats } from '../../shared/types'

const props = defineProps<{ stats: Stats }>()
const { show, move, hide } = useTooltip()

// Fixed internal coordinate space; the SVG scales to its container via viewBox,
// so we don't need to measure width at runtime.
const W = 800
const H = 400

// Every node that can render gets its own colour — the interview rungs used to
// fall through to the grey default, which made the whole middle of the diagram
// look like one undifferentiated flow.
const NODE_COLORS: Record<string, string> = {
  applications: 'var(--stone)', pending: 'var(--blue)',
  stage0: 'var(--olive)', stage1: 'var(--plum)', stage2: 'var(--teal)',
  stillOpen: 'var(--green)', awaiting: 'var(--amber)',
  rejected: 'var(--rust)', noAnswer: 'var(--stone)',
  offers: 'var(--teal)', accepted: 'var(--green)', declined: 'var(--rust)',
}
const nodeColor = (n: any) => NODE_COLORS[n.id] || 'var(--stone)'

// Terminal nodes map straight to a kanban bucket, so hovering can list who is
// sitting there. Interview rungs are listed from each job's own stage instead.
const NODE_TO_BUCKET: Record<string, string> = {
  awaiting: 'awaiting', rejected: 'rejected', noAnswer: 'noAnswer',
  accepted: 'offerAccepted', declined: 'offerDeclined', pending: 'pending',
}
const isRung = (id: string) => id.startsWith('stage')

const layout = computed(() => {
  const graph = props.stats.sankey
  const links = graph.links.filter((l) => l.value > 0)
  const usedIds = new Set(links.flatMap((l) => [l.source, l.target]))
  const nodes = graph.nodes.filter((n) => usedIds.has(n.id))
  if (!links.length) return { nodes: [] as any[], links: [] as any[] }

  const gen = d3sankey<any, any>()
    .nodeId((d: any) => d.id)
    .nodeWidth(8)
    .nodePadding(34)
    // Top inset leaves room for the two-line labels that middle columns draw
    // ABOVE their node; side insets leave room for the outer columns' labels.
    .extent([[110, 46], [W - 110, H - 14]])

  const out = gen({
    nodes: nodes.map((d) => ({ ...d })),
    links: links.map((d) => ({ ...d })),
  })
  const linkPath = sankeyLinkHorizontal()
  return {
    nodes: out.nodes as any[],
    links: (out.links as any[]).map((l) => ({ ...l, path: linkPath(l) as string })),
  }
})

const linkColor = (l: any) => NODE_COLORS[l.target.id] || 'var(--stone)'

// Labels used to be placed by "is this node left of centre?", which pushed the
// middle columns' text sideways into the neighbouring column and overlapped
// once the interview rungs added columns. Now only the outermost columns label
// sideways (outward, into the SVG margin); every column in between labels
// ABOVE its node, where there is always clear space.
const columnXs = computed(() =>
  [...new Set(layout.value.nodes.map((n: any) => Math.round(n.x0)))].sort((a, b) => a - b),
)
type Side = 'left' | 'right' | 'above'
function labelSide(n: any): Side {
  const cols = columnXs.value
  const x = Math.round(n.x0)
  // Outermost columns label OUTWARD into the side margins, so their text never
  // crosses a ribbon; everything between labels above its own node.
  if (cols.length > 1 && x === cols[0]) return 'left'
  if (cols.length > 1 && x === cols[cols.length - 1]) return 'right'
  return 'above'
}
const anchorFor = (n: any) => {
  const s = labelSide(n)
  return s === 'left' ? 'end' : s === 'right' ? 'start' : 'middle'
}
const labelX = (n: any) => {
  const s = labelSide(n)
  if (s === 'left') return n.x0 - 12
  if (s === 'right') return n.x1 + 12
  return (n.x0 + n.x1) / 2
}
// Sideways labels sit on the node's vertical centre; stacked labels sit above it.
const valueY = (n: any) => (labelSide(n) === 'above' ? n.y0 - 20 : (n.y0 + n.y1) / 2 - 4)
const labelY = (n: any) => (labelSide(n) === 'above' ? n.y0 - 7 : (n.y0 + n.y1) / 2 + 11)

// esc() and pct() are auto-imported from app/utils/format.ts

function nodeTip(n: any): string {
  const rung = isRung(n.id)
  let html =
    `<div class="t-head">${esc(n.label)} — ${n.value}</div>` +
    `<div class="t-sub">${pct(n.value, props.stats.total)} of applications${rung ? ' reached this round' : ''}</div>`

  // For an interview rung, list the processes whose furthest point was exactly
  // this round — that is the question the diagram is there to answer.
  const here = rung
    ? props.stats.jobs.filter((j) => j.stage === n.label)
    : props.stats.jobs.filter((j) => j.bucket === NODE_TO_BUCKET[n.id])
  if (rung && here.length) html += `<div class="t-sub">${here.length} stopped here</div>`
  const names = here.map((j) => j.company)
  if (names.length && names.length <= 8) {
    html += `<div class="t-list">${names.map(esc).join('<br>')}</div>`
  }
  return html
}
function linkTip(l: any): string {
  return (
    `<div class="t-head">${esc(l.source.label)} → ${esc(l.target.label)} — ${l.value}</div>` +
    `<div class="t-sub">${pct(l.value, l.source.value)} of ${esc(l.source.label)} · ${pct(l.value, props.stats.total)} of all</div>`
  )
}
</script>

<template>
  <svg id="sankey" role="img" aria-label="Sankey diagram of application outcomes" :viewBox.attr="`0 0 ${W} ${H}`">
    <g>
      <path
        v-for="(l, i) in layout.links"
        :key="'l' + i"
        class="ribbon draw"
        :d="l.path"
        fill="none"
        :stroke="linkColor(l)"
        stroke-opacity="0.55"
        :stroke-width="Math.max(1.5, l.width)"
        @mouseenter="show(linkTip(l), $event)"
        @mousemove="move($event)"
        @mouseleave="hide()"
      />
    </g>
    <g v-for="(n, i) in layout.nodes" :key="'n' + i">
      <!-- invisible padded hover target. .attr forces setAttribute for the
           getter-only SVG geometry props (see VelocityChart note). -->
      <rect
        :x.attr="n.x0 - 5"
        :y.attr="n.y0 - 5"
        :width.attr="n.x1 - n.x0 + 10"
        :height.attr="Math.max(2, n.y1 - n.y0) + 10"
        fill="transparent"
        @mouseenter="show(nodeTip(n), $event)"
        @mousemove="move($event)"
        @mouseleave="hide()"
      />
      <rect
        :x.attr="n.x0"
        :y.attr="n.y0"
        :width.attr="n.x1 - n.x0"
        :height.attr="Math.max(2, n.y1 - n.y0)"
        rx="2"
        :fill="nodeColor(n)"
        pointer-events="none"
      />
      <text class="node-value" :x.attr="labelX(n)" :y.attr="valueY(n)" :text-anchor="anchorFor(n)">
        {{ n.value }}
      </text>
      <text class="node-label" :x.attr="labelX(n)" :y.attr="labelY(n)" :text-anchor="anchorFor(n)">
        {{ n.label }}
      </text>
    </g>
  </svg>
</template>
