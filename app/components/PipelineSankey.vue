<script setup lang="ts">
import { computed } from 'vue'
import { sankey as d3sankey, sankeyLinkHorizontal } from 'd3-sankey'
import type { Stats } from '../../shared/types'

const props = defineProps<{ stats: Stats }>()
const { show, move, hide } = useTooltip()

// Fixed internal coordinate space; the SVG scales to its container via viewBox,
// so we don't need to measure width at runtime.
const W = 720
const H = 360

const NODE_COLORS: Record<string, string> = {
  applications: 'var(--stone)', pending: 'var(--blue)', interviewed: 'var(--olive)',
  progressing: 'var(--plum)', awaiting: 'var(--amber)', rejected: 'var(--rust)',
  noAnswer: 'var(--stone)', offers: 'var(--teal)', accepted: 'var(--green)', declined: 'var(--rust)',
}
// Terminal nodes map straight to a kanban bucket; stage nodes ("ever reached")
// also know which bucket is *currently* sitting there.
const NODE_TO_BUCKET: Record<string, string> = {
  awaiting: 'awaiting', rejected: 'rejected', noAnswer: 'noAnswer',
  accepted: 'offerAccepted', declined: 'offerDeclined',
  pending: 'pending', interviewed: 'interviewed', progressing: 'progressing',
}
const STAGE_NODES = new Set(['pending', 'interviewed', 'progressing'])

const layout = computed(() => {
  const graph = props.stats.sankey
  const links = graph.links.filter((l) => l.value > 0)
  const usedIds = new Set(links.flatMap((l) => [l.source, l.target]))
  const nodes = graph.nodes.filter((n) => usedIds.has(n.id))
  if (!links.length) return { nodes: [] as any[], links: [] as any[] }

  const gen = d3sankey<any, any>()
    .nodeId((d: any) => d.id)
    .nodeWidth(6)
    .nodePadding(28)
    .extent([[8, 24], [W - 8, H - 12]])

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

const isLeft = (n: any) => n.x0 < W / 2
const labelX = (n: any) => (isLeft(n) ? n.x0 - 10 : n.x1 + 10)
const linkColor = (l: any) => NODE_COLORS[l.target.id] || 'var(--stone)'

// esc() and pct() are auto-imported from app/utils/format.ts

function nodeTip(n: any): string {
  const isStage = STAGE_NODES.has(n.id)
  let html =
    `<div class="t-head">${esc(n.label)} — ${n.value}</div>` +
    `<div class="t-sub">${pct(n.value, props.stats.total)} of applications${isStage ? ' reached this stage' : ''}</div>`
  const bucket = NODE_TO_BUCKET[n.id]
  if (bucket) {
    const here = props.stats.jobs.filter((j) => j.bucket === bucket)
    if (isStage) html += `<div class="t-sub">${here.length} currently here</div>`
    const names = here.map((j) => j.company)
    if (names.length && names.length <= 8) {
      html += `<div class="t-list">${names.map(esc).join('<br>')}</div>`
    }
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
        fill="#d6d4cf"
        pointer-events="none"
      />
      <text class="node-value" :x.attr="labelX(n)" :y.attr="(n.y0 + n.y1) / 2 - 4" :text-anchor="isLeft(n) ? 'end' : 'start'">
        {{ n.value }}
      </text>
      <text class="node-label" :x.attr="labelX(n)" :y.attr="(n.y0 + n.y1) / 2 + 11" :text-anchor="isLeft(n) ? 'end' : 'start'">
        {{ n.label }}
      </text>
    </g>
  </svg>
</template>
