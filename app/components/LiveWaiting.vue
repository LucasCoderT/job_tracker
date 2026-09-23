<script setup lang="ts">
import { computed } from 'vue'
/**
 * "Something is with the Mac, and this page is watching for it."
 *
 * Shown only while work is outstanding. A page with nothing pending renders
 * nothing at all — a permanent "live" badge is noise, and worse, it would claim
 * freshness on a page that has stopped polling precisely because it is settled.
 *
 * The socket state is deliberately not a connection indicator. Whether the
 * WebSocket is up is this app's business, not his: polling covers the same
 * ground either way, so a red "disconnected" dot would report a problem he can
 * neither see the effect of nor do anything about. The only thing it changes
 * here is the wording of the title attribute, for when something looks wrong.
 */
const props = defineProps<{
  /** How many things are waiting. Zero renders nothing. */
  count: number
  /** A fetch is in flight right now. */
  refreshing?: boolean
  /** Socket state from useLiveRefresh, for the tooltip only. */
  status?: 'idle' | 'connecting' | 'open' | 'closed'
  /**
   * The complete text, count included if it is worth showing. A caller that
   * omits it gets the postings-listing default.
   *
   * It is the whole string rather than a noun this component pluralises,
   * because the count means different things per page: on a listing it is how
   * many jobs are busy and worth reading, while on one posting's page it is how
   * many *kinds* of work are outstanding, and "2 drafting" would be a plain
   * lie about a page that is drafting answers and re-reading a form.
   */
  label?: string
}>()

const text = computed(() => {
  if (props.refreshing) return 'Updating'
  if (props.label) return props.label
  return `${props.count} ${props.count === 1 ? 'job with the Mac' : 'jobs with the Mac'}`
})

const title = computed(() =>
  props.status === 'open'
    ? 'Updating live. You do not need to refresh.'
    : 'Checking every few seconds. You do not need to refresh.',
)
</script>

<template>
  <span v-if="count > 0" class="live-waiting" :title="title">
    <span class="live-dot" :class="{ 'is-busy': refreshing }" aria-hidden="true" />
    <span>{{ text }}</span>
  </span>
</template>
