<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { EiCandidate, EiTimeSpent, EiWeek } from '../../shared/types'
// Runtime value, so it goes through the #shared alias like #shared/bank does;
// a relative import of a .ts file is not resolvable from the built bundle.
import { EI_TIME_OPTIONS } from '#shared/types'

/**
 * The EI week: what the site saw him do, ready to confirm into the Notion log.
 *
 * The automation does a lot of the work now — the Mac evaluates postings,
 * builds CVs and drafts form answers, often overnight — and none of that is
 * his job-search time. So this page only ever proposes rows for things he did
 * himself, shows the timestamps behind each one, and asks him for the hours.
 * Nothing reaches Notion until he sets a time and presses Add.
 */
useHead({ title: 'EI activity' })

const monday = ref('')
const { data, pending, error, refresh } = await useFetch<EiWeek>(
  () => (monday.value ? `/api/ei/week?monday=${monday.value}` : '/api/ei/week'),
  { key: () => `ei:${monday.value || 'this'}` },
)

const candidates = computed(() => data.value?.candidates ?? [])
const pendingRows = computed(() => candidates.value.filter((c) => !c.alreadyLogged))
const logged = computed(() => data.value?.logged ?? [])

// ---- per-row state: hours he sets, and rows he says did not happen ----
const hours = ref<Record<string, EiTimeSpent | null>>({})
const dropped = ref<Record<string, boolean>>({})
const open = ref<Record<string, boolean>>({})

watch(
  candidates,
  (list) => {
    for (const c of list) if (!(c.key in hours.value)) hours.value[c.key] = null
  },
  { immediate: true },
)

const ready = computed(() => pendingRows.value.filter((c) => !dropped.value[c.key] && hours.value[c.key]))
const missing = computed(() => pendingRows.value.filter((c) => !dropped.value[c.key] && !hours.value[c.key]))

const METHOD_ICON: Record<string, string> = {
  'Applied online': 'pi pi-send',
  'Resume/cover letter prep': 'pi pi-file-edit',
  'Searched online': 'pi pi-search',
  'Attended interview': 'pi pi-users',
  'Email application': 'pi pi-envelope',
  Networking: 'pi pi-share-alt',
}

function shiftWeek(days: number) {
  const base = new Date(`${data.value?.monday ?? new Date().toISOString().slice(0, 10)}T12:00:00Z`)
  base.setUTCDate(base.getUTCDate() + days)
  monday.value = base.toISOString().slice(0, 10)
}

const dayName = (d: string) =>
  new Date(`${d}T12:00:00Z`).toLocaleDateString('en-CA', { weekday: 'short', month: 'short', day: 'numeric' })

// ---- confirming ----
const busy = ref(false)
const toast = ref('')
let toastTimer: ReturnType<typeof setTimeout> | undefined
function say(text: string) {
  clearTimeout(toastTimer)
  toast.value = text
  toastTimer = setTimeout(() => (toast.value = ''), 6000)
}

async function confirmAll() {
  if (!ready.value.length || busy.value) return
  busy.value = true
  try {
    const res = await $fetch<{ written: number; failed: { activity: string; error: string }[] }>('/api/ei/entries', {
      method: 'POST',
      body: {
        entries: ready.value.map((c) => ({
          date: c.date,
          method: c.method,
          activity: c.activity,
          notes: c.notes,
          outcome: c.outcome,
          timeSpent: hours.value[c.key],
        })),
      },
    })
    if (res.failed.length) {
      say(`${res.written} added · ${res.failed.length} failed: ${res.failed[0]!.error}`)
    } else {
      say(`${res.written} ${res.written === 1 ? 'entry' : 'entries'} added to the EI log.`)
    }
    hours.value = {}
    await refresh()
  } catch (err: any) {
    say(err?.data?.statusMessage || err?.message || "Couldn't write to the log")
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="packs-page ei-page">
    <header>
      <div>
        <NuxtLink to="/" class="crumb"><i class="pi pi-arrow-left" /> Pipeline</NuxtLink>
        <h1>EI activity<span v-if="data" class="pos"> · week of {{ dayName(data.monday) }}</span></h1>
      </div>
      <div class="header-tools">
        <PrimeButton icon="pi pi-chevron-left" size="small" severity="secondary" outlined aria-label="Previous week" @click="shiftWeek(-7)" />
        <PrimeButton icon="pi pi-chevron-right" size="small" severity="secondary" outlined aria-label="Next week" @click="shiftWeek(7)" />
      </div>
    </header>

    <p class="lede">
      <span class="lede-strong">Your hours, not the Mac's.</span>
      These are things the site saw <em>you</em> do — the evaluations, CV builds and answer drafts it ran on its own are
      not here, because they are not your job-search time. Check each row against what you remember, drop anything that
      did not happen, set the time, and it goes in the log.
    </p>

    <div v-if="pending" class="skel" aria-busy="true" aria-label="Loading the week">
      <div class="skel-panel sk" style="height: 360px" />
    </div>

    <PrimeMessage v-else-if="error" severity="error" :closable="false">{{ error.message }}</PrimeMessage>
    <PrimeMessage v-else-if="data && !data.enabled" severity="warn" :closable="false">{{ data.error }}</PrimeMessage>
    <PrimeMessage v-else-if="data?.error" severity="error" :closable="false">{{ data.error }}</PrimeMessage>

    <template v-else-if="data">
      <PrimeCard v-if="pendingRows.length" class="sec" aria-label="To confirm">
        <template #content>
        <div class="deck-head">
          <h2>To confirm<span class="mono faint"> {{ pendingRows.length }}</span></h2>
          <span class="mono faint">{{ ready.length }} ready · {{ missing.length }} need a time</span>
        </div>

        <div class="ei-rows">
          <div v-for="c in pendingRows" :key="c.key" class="ei-row" :class="{ dropped: dropped[c.key] }">
            <div class="ei-when mono">
              <span class="ei-day">{{ dayName(c.date) }}</span>
              <span class="ei-method"><i :class="METHOD_ICON[c.method] || 'pi pi-circle'" />{{ c.method }}</span>
            </div>

            <div class="ei-what">
              <p class="ei-activity">{{ c.activity }}</p>
              <p v-if="c.notes" class="ei-notes">{{ c.notes }}</p>
              <p v-if="c.sameDayLogged.length" class="ei-dupe">
                <i class="pi pi-exclamation-triangle" />
                Already logged that day under {{ c.method }}:
                <span v-for="(l, i) in c.sameDayLogged" :key="i" class="mono">{{ i ? ' · ' : '' }}“{{ l }}”</span>
              </p>
              <button type="button" class="linkish ei-why" @click="open[c.key] = !open[c.key]">
                {{ open[c.key] ? 'hide' : 'why this is here' }} ({{ c.evidence.length }})
              </button>
              <ul v-if="open[c.key]" class="ei-evidence mono">
                <li v-for="(e, i) in c.evidence" :key="i">{{ e }}</li>
              </ul>
            </div>

            <div class="ei-time">
              <PrimeSelect
                v-model="hours[c.key]"
                :options="EI_TIME_OPTIONS"
                placeholder="Time"
                size="small"
                :disabled="dropped[c.key]"
                class="ei-select"
              />
              <button
                type="button"
                class="icon-btn danger"
                :title="dropped[c.key] ? 'Put it back' : 'This did not happen — drop it'"
                :aria-label="dropped[c.key] ? `Restore ${c.activity}` : `Drop ${c.activity}`"
                @click="dropped[c.key] = !dropped[c.key]"
              >
                <i :class="dropped[c.key] ? 'pi pi-undo' : 'pi pi-times'" />
              </button>
            </div>
          </div>
        </div>

        <div class="ei-actions">
          <span v-if="missing.length" class="muted small">
            {{ missing.length }} {{ missing.length === 1 ? 'row has' : 'rows have' }} no time set and will be left out.
          </span>
          <PrimeButton
            :label="ready.length ? `Add ${ready.length} to the log` : 'Set a time first'"
            icon="pi pi-check"
            size="small"
            :disabled="!ready.length"
            :loading="busy"
            @click="confirmAll"
          />
        </div>
        </template>
      </PrimeCard>

      <PrimeMessage v-else severity="success" :closable="false">
        Nothing outstanding — everything the site saw this week is already in the log.
      </PrimeMessage>

      <PrimeCard class="sec" aria-label="Already logged">
        <template #content>
        <div class="deck-head">
          <h2>Already in the log<span class="mono faint"> {{ logged.length }}</span></h2>
        </div>
        <p v-if="!logged.length" class="muted small">No entries for this week yet.</p>
        <table v-else class="ei-logged">
          <tbody>
            <tr v-for="(l, i) in logged" :key="i">
              <td class="mono faint">{{ l.date }}</td>
              <td class="mono faint">{{ l.method }}</td>
              <td>{{ l.activity }}</td>
              <td class="mono">{{ l.timeSpent || '—' }}</td>
            </tr>
          </tbody>
        </table>
        </template>
      </PrimeCard>

      <Transition name="toast">
        <div v-if="toast" class="toast" role="status">
          <i class="pi pi-check-circle" />
          <span>{{ toast }}</span>
          <button type="button" class="toast-x" aria-label="Dismiss" @click="toast = ''"><i class="pi pi-times" /></button>
        </div>
      </Transition>
    </template>
  </div>
</template>
