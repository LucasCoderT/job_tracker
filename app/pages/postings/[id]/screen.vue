<script setup lang="ts">
/**
 * First-call prep for one posting.
 *
 * Seven of the ten applications that ever reached an interview stopped at the
 * first screen. This is the page for the half hour before that call: the six
 * questions every screen opens with, whose answers carry forward from the last
 * one he prepared, then what this posting's own evaluation says they will push
 * on — hard stops and high-importance requirements it rated him weak on.
 *
 * Every answer is his. Nothing on this page writes one, for the same reason
 * the answer bank does not: a generated answer fails in the room.
 */
import { computed, ref } from 'vue'
import type { PostingDetail, ScreenPrep, ScreenPrompt } from '../../../../shared/types'

const route = useRoute()
const id = computed(() => String(route.params.id))

const { data: posting } = await useFetch<PostingDetail>(() => `/api/postings/${id.value}`, {
  key: () => `posting:${id.value}`,
})
const { data, pending, error } = await useFetch<ScreenPrep>(() => `/api/postings/${id.value}/screen`, {
  key: () => `screen:${id.value}`,
})

const meta = computed(() => posting.value?.meta)
const { crumbs, parent } = useTrail(
  () => [{ label: meta.value?.company || 'Posting', to: `/postings/${id.value}` }, { label: 'Screen prep' }],
  '/postings',
)
useHead({ title: () => (meta.value ? `${meta.value.company} — screen prep` : 'Screen prep') })

const prompts = computed<ScreenPrompt[]>(() => data.value?.prompts ?? [])
const standing = computed(() => prompts.value.filter((p) => p.kind === 'standing'))
const probes = computed(() => prompts.value.filter((p) => p.kind === 'probe'))
const fromCalls = computed(() => prompts.value.filter((p) => p.kind === 'asked'))
const ready = computed(() => prompts.value.filter((p) => p.answer.trim()).length)

/**
 * Spoken length, not written length. People read ~250 wpm and speak ~150, and
 * the failure mode on a screen is a two-minute answer to a sixty-second
 * question — so the count that matters is how long it takes out loud.
 */
function seconds(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length
  return Math.round((words / 150) * 60)
}
const spoken = (text: string) => {
  const s = seconds(text)
  if (!s) return ''
  return s < 60 ? `${s}s aloud` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s aloud`
}
const longFor = (p: ScreenPrompt) => p.kind === 'standing' && seconds(p.answer) > 90

const askedText = ref('')
const drafts = ref<Record<string, string>>({})
const busy = ref('')
const toast = ref('')
let toastTimer: ReturnType<typeof setTimeout> | undefined
function say(text: string) {
  clearTimeout(toastTimer)
  toast.value = text
  toastTimer = setTimeout(() => (toast.value = ''), 4000)
}

const valueFor = (p: ScreenPrompt) => drafts.value[p.id] ?? p.answer
const dirty = (p: ScreenPrompt) => (drafts.value[p.id] ?? p.answer) !== p.answer

/**
 * After the call. A question he was actually asked outranks anything assembled
 * from a JD, and at one interview per eighteen applications it is the rarest
 * input here — so it is recorded once and prompts every future screen.
 */
async function recordAsked() {
  const text = askedText.value.trim()
  if (!text || busy.value) return
  busy.value = 'asked'
  try {
    data.value = await $fetch<ScreenPrep>(`/api/postings/${id.value}/screen/asked`, {
      method: 'POST',
      body: { text },
    })
    askedText.value = ''
    say('Recorded — it will come up on every screen from now on')
  } catch (err: any) {
    say(err?.statusMessage || 'Could not record that')
  } finally {
    busy.value = ''
  }
}

/** Remove a question recorded by mistake, so it stops appearing on every prep. */
async function forget(p: ScreenPrompt) {
  if (busy.value) return
  busy.value = p.id
  try {
    data.value = await $fetch<ScreenPrep>(`/api/postings/${id.value}/screen/asked?prompt=${p.id}`, {
      method: 'DELETE',
    })
    say('Removed')
  } catch (err: any) {
    say(err?.statusMessage || 'Could not remove that')
  } finally {
    busy.value = ''
  }
}

async function save(p: ScreenPrompt) {
  if (busy.value) return
  busy.value = p.id
  try {
    const next = await $fetch<ScreenPrep>(`/api/postings/${id.value}/screen/${p.id}`, {
      method: 'PUT',
      body: { answer: valueFor(p) },
    })
    data.value = next
    delete drafts.value[p.id]
    say(p.kind === 'standing' ? 'Saved — the next screen starts from this' : 'Saved')
  } catch (err: any) {
    say(err?.statusMessage || 'Could not save that')
  } finally {
    busy.value = ''
  }
}
</script>

<template>
  <div class="packs-page">
    <AppCrumbs :crumbs="crumbs" />

    <PrimeProgressSpinner v-if="pending" style="width:42px;height:42px" />
    <PrimeMessage v-else-if="error" severity="error">Could not load the screen prep.</PrimeMessage>

    <template v-else>
      <header class="screen-head">
        <h1>{{ meta?.company }} — the first call</h1>
        <p class="screen-sub">
          {{ ready }} of {{ prompts.length }} prepared<span v-if="meta?.role"> · {{ meta.role }}</span>
        </p>
        <p class="screen-note">
          Seven of the ten applications that reached an interview stopped at the first screen. These are your words —
          nothing here writes them for you.
        </p>
      </header>

      <section class="screen-block">
        <h2 class="screen-h2">Every screen asks these</h2>
        <p class="screen-h2-sub">Answers carry forward to the next call, so this gets shorter each time.</p>

        <article v-for="p in standing" :key="p.id" class="screen-card">
          <h3>{{ p.prompt }}</h3>
          <p class="screen-because">{{ p.because }}</p>
          <textarea
            :id="`prompt-${p.id}`"
            class="screen-input"
            rows="4"
            :value="valueFor(p)"
            :placeholder="'In your own words…'"
            @input="drafts[p.id] = ($event.target as HTMLTextAreaElement).value"
          />
          <div class="screen-foot">
            <span class="screen-flags mono">
              <span v-if="p.source === 'carried' && !dirty(p)" class="flag carried">from your last screen</span>
              <span v-if="valueFor(p).trim()" class="flag">{{ spoken(valueFor(p)) }}</span>
              <span v-if="longFor(p)" class="flag warn">over 90s — they will cut you off</span>
            </span>
            <PrimeButton
              size="small"
              :label="busy === p.id ? 'Saving…' : 'Save'"
              :disabled="!dirty(p) || busy === p.id"
              @click="save(p)"
            />
          </div>
        </article>
      </section>

      <section v-if="fromCalls.length" class="screen-block">
        <h2 class="screen-h2">Asked on real calls</h2>
        <p class="screen-h2-sub">Questions you were actually asked. These outrank anything guessed from a job description.</p>

        <article v-for="p in fromCalls" :key="p.id" class="screen-card screen-card--asked">
          <h3>{{ p.prompt }}</h3>
          <p class="screen-because">{{ p.because }}</p>
          <textarea
            :id="`prompt-${p.id}`"
            class="screen-input"
            rows="3"
            :value="valueFor(p)"
            placeholder="In your own words…"
            @input="drafts[p.id] = ($event.target as HTMLTextAreaElement).value"
          />
          <div class="screen-foot">
            <span class="screen-flags mono">
              <span v-if="p.source === 'carried' && !dirty(p)" class="flag carried">from your last screen</span>
              <span v-if="valueFor(p).trim()" class="flag">{{ spoken(valueFor(p)) }}</span>
            </span>
            <button class="screen-forget" type="button" :disabled="busy === p.id" @click="forget(p)">
              Not asked
            </button>
            <PrimeButton
              size="small"
              :label="busy === p.id ? 'Saving…' : 'Save'"
              :disabled="!dirty(p) || busy === p.id"
              @click="save(p)"
            />
          </div>
        </article>
      </section>

      <section v-if="probes.length" class="screen-block">
        <h2 class="screen-h2">What this one will push on</h2>
        <p class="screen-h2-sub">From the evaluation of this posting — its hard stops and the requirements it rated you weak on.</p>

        <article v-for="p in probes" :key="p.id" class="screen-card screen-card--probe">
          <h3>{{ p.prompt }}</h3>
          <p class="screen-because">{{ p.because }}</p>
          <textarea
            :id="`prompt-${p.id}`"
            class="screen-input"
            rows="3"
            :value="valueFor(p)"
            placeholder="How you answer this, plainly…"
            @input="drafts[p.id] = ($event.target as HTMLTextAreaElement).value"
          />
          <div class="screen-foot">
            <span class="screen-flags mono">
              <span v-if="valueFor(p).trim()" class="flag">{{ spoken(valueFor(p)) }}</span>
            </span>
            <PrimeButton
              size="small"
              :label="busy === p.id ? 'Saving…' : 'Save'"
              :disabled="!dirty(p) || busy === p.id"
              @click="save(p)"
            />
          </div>
        </article>
      </section>

      <section class="screen-block">
        <h2 class="screen-h2">After the call</h2>
        <p class="screen-h2-sub">What did they actually ask? Each one becomes a prompt on every screen from here on.</p>
        <div class="screen-retro">
          <input
            id="asked-input"
            v-model="askedText"
            class="screen-input"
            type="text"
            placeholder="e.g. How do you decide what to test?"
            @keyup.enter="recordAsked"
          />
          <PrimeButton
            size="small"
            :label="busy === 'asked' ? 'Saving…' : 'Record'"
            :disabled="!askedText.trim() || busy === 'asked'"
            @click="recordAsked"
          />
        </div>
      </section>

      <p v-if="!probes.length" class="screen-empty">
        No evaluation on this posting yet, so there is nothing specific to prepare for beyond the standing questions.
      </p>

      <NuxtLink class="screen-back" :to="`/postings/${id}?from=${parent}`">← Back to the brief</NuxtLink>
    </template>

    <PrimeToast />
    <div v-if="toast" class="screen-toast" role="status">{{ toast }}</div>
  </div>
</template>
