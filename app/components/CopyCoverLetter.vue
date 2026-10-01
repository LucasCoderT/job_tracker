<script setup lang="ts">
/**
 * One press puts the cover letter's body on the clipboard, for a form that
 * wants it pasted into a textarea instead of uploaded.
 *
 * The text is fetched when the page mounts, not on the press: iOS Safari only
 * lets a page write the clipboard inside the tap that asked for it, and an
 * awaited fetch in between spends that permission.
 */
const props = defineProps<{ postingId: string; name: string; compact?: boolean }>()

const text = ref<string | null>(null)
const status = ref('')
const selectable = ref(false)
const box = ref<HTMLTextAreaElement | null>(null)
let timer: ReturnType<typeof setTimeout> | undefined

const url = computed(() => `/api/postings/${props.postingId}/artifacts/${encodeURIComponent(props.name)}`)

async function load(): Promise<string> {
  if (text.value === null) text.value = (await $fetch<string>(url.value, { responseType: 'text' })).trim()
  return text.value
}

onMounted(() => load().catch(() => {}))
watch(url, () => {
  text.value = null
  load().catch(() => {})
})

// Forms cap these fields by characters about as often as by words, so the
// count shown is both.
const size = computed(() => {
  if (!text.value) return ''
  const words = text.value.split(/\s+/).length
  return `${words} words · ${text.value.length.toLocaleString('en-CA')} characters`
})

function say(msg: string) {
  clearTimeout(timer)
  status.value = msg
  timer = setTimeout(() => (status.value = ''), 4000)
}

async function copy() {
  try {
    // Already loaded is the usual case: write before any await at all.
    await (text.value !== null
      ? navigator.clipboard.writeText(text.value)
      : load().then((t) => navigator.clipboard.writeText(t)))
    selectable.value = false
    say('Copied.')
  } catch {
    if (text.value === null) return say("Couldn't load the letter.")
    // No clipboard (an insecure origin, or a browser that did not count the
    // tap): show the text selected, so it is one ⌘C away instead of none.
    selectable.value = true
    await nextTick()
    box.value?.select()
    say('Copy failed — the letter is selected, press ⌘C.')
  }
}
</script>

<template>
  <div class="copy-letter" :class="{ compact }">
    <PrimeButton
      label="Copy cover letter"
      icon="pi pi-copy"
      size="small"
      severity="secondary"
      outlined
      :title="size || undefined"
      @click="copy"
    />
    <!-- In a toolbar the size rides on the button's title; only news gets a line. -->
    <p v-if="!compact || status" class="copy-letter-sub mono" aria-live="polite">{{ status || size || 'The body only, for a form that wants it pasted.' }}</p>
    <textarea v-if="selectable" ref="box" class="copy-letter-text" readonly rows="8" :value="text ?? ''" />
  </div>
</template>
