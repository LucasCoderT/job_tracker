import { reactive } from 'vue'

/**
 * A single shared floating tooltip, reused by every chart (Sankey now; velocity,
 * sources, board later). Components call show/move/hide; one <AppTooltip> at the
 * page root renders the state. Replaces the original's imperative showTip/moveTip.
 */
const state = reactive({
  visible: false,
  // Anchor point (cursor + offset). <AppTooltip> clamps to the viewport.
  x: 0,
  y: 0,
  html: '',
})

const PAD = 14

export function useTooltip() {
  function show(html: string, evt: MouseEvent) {
    state.html = html
    state.visible = true
    move(evt)
  }
  function move(evt: MouseEvent) {
    state.x = evt.clientX + PAD
    state.y = evt.clientY + PAD
  }
  function hide() {
    state.visible = false
  }
  return { state, show, move, hide, PAD }
}
