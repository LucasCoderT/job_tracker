<script setup lang="ts">
import { computed, ref } from 'vue'
import type { EiCandidate, EiMethod, EiOutcome, EiTimeSpent, EiWeek, EiWriteResult } from '../../shared/types'
import { EI_TIME_OPTIONS } from '#shared/types'

/**
 * "Log EI time" — the end-of-day version of the EI page.
 *
 * Press it when he is done for the day: it gathers what the site saw him do
 * today, starts every row from a suggested time (with the arithmetic beside
 * it), and one press writes the lot to the Notion log. Three ways to finish:
 *
 *   - take the suggestions as they are, and Log;
 *   - adjust a time, drop a row that did not happen, or add something the site
 *     could not see (an interview, a call, a networking message);
 *   - "Nothing suitable today" — the day he searched and found nothing worth
 *     applying to, which is still job-search activity and still gets a row.
 *
 * Nothing reaches Notion until Log is pressed, and what is written is what is
 * on screen at that moment. The suggestions only ever pre-fill the boxes.
 *
 * The data is fetched when the dialog opens, not with the dashboard: the week
 * route reads the whole applications database and the EI log, which is too
 * much to pay on every page load for a button pressed once a day.
 */

const open = ref(false)
const loading = ref(false)
const loadError = ref('')
const week = ref<EiWeek | null>(null)

const hours = ref<Record<string, EiTimeSpent | null>>({})
const dropped = ref<Record<string, boolean>>({})
/** Rows he adds himself: "nothing suitable" and anything the site cannot see. */
const extras = ref<EiCandidate[]>([])

const today = computed(() => week.value?.today ?? '')
const seen = computed(() => (week.value?.candidates ?? []).filter((c) => c.date === today.value && !c.alreadyLogged))
const loggedToday = computed(() => (week.value?.logged ?? []).filter((l) => l.date === today.value))
const rows = computed(() => [...seen.value, ...extras.value])
const live = computed(() => rows.value.filter((r) => !dropped.value[r.key]))
const ready = computed(() => live.value.filter((r) => hours.value[r.key]))

const MINUTES: Record<EiTimeSpent, number> = { '30 min': 30, '1 hour': 60, '1.5 hours': 90, '2 hours': 120 }
const totalText = computed(() => {
  const m = ready.value.reduce((t, r) => t + MINUTES[hours.value[r.key]!], 0)
  const h = Math.floor(m / 60)
  return h ? `${h}h${m % 60 ? ` ${m % 60}m` : ''}` : `${m}m`
})

const dayTitle = computed(() =>
  today.value
    ? new Date(`${today.value}T12:00:00Z`).toLocaleDateString('en-CA', { weekday: 'long', month: 'long', day: 'numeric' })
    : 'Today',
)

async function show() {
  open.value = true
  await load()
}

async function load() {
  loading.value = true
  loadError.value = ''
  try {
    const w = await $fetch<EiWeek>('/api/ei/week', { query: { t: Date.now() } })
    if (w.error) throw new Error(w.error)
    week.value = w
    // Start every row the site saw from its suggestion — the point of the
    // button is that the common day is one press.
    hours.value = Object.fromEntries(
      w.candidates.filter((c) => c.date === w.today && !c.alreadyLogged).map((c) => [c.key, c.suggested]),
    )
    dropped.value = {}
    extras.value = []
  } catch (err: any) {
    loadError.value = err?.data?.statusMessage || err?.message || "Couldn't read today's activity"
  } finally {
    loading.value = false
  }
}

const sameDayFor = (method: string) =>
  loggedToday.value.filter((l) => l.method === method).map((l) => `${l.activity}${l.timeSpent ? ` (${l.timeSpent})` : ''}`)

// ---- "Nothing suitable today" ----

const hasSearchRow = computed(() => live.value.some((r) => r.method === 'Searched online'))

function nothingSuitable() {
  const key = `nothing:${today.value}`
  if (extras.value.some((e) => e.key === key)) return
  extras.value.push({
    key,
    date: today.value,
    method: 'Searched online',
    // His own wording, from the entries he has written by hand for days like this.
    activity: 'Searched job boards for software developer roles',
    subject: '',
    notes: '',
    outcome: 'No suitable postings found',
    evidence: ['you said nothing suitable came up today'],
    alreadyLogged: false,
    sameDayLogged: sameDayFor('Searched online'),
    suggested: '30 min',
    suggestedWhy: 'a routine search',
  })
  hours.value = { ...hours.value, [key]: '30 min' }
}

// ---- Something the site cannot see ----

const METHODS: EiMethod[] = [
  'Attended interview',
  'Networking',
  'Email application',
  'Applied online',
  'Resume/cover letter prep',
  'Searched online',
]
const OUTCOMES: EiOutcome[] = ['Waiting on reply', 'Interview scheduled', 'Applied', 'No suitable postings found']
const OUTCOME_FOR: Record<EiMethod, EiOutcome> = {
  'Attended interview': 'Waiting on reply',
  Networking: 'Waiting on reply',
  'Email application': 'Waiting on reply',
  'Applied online': 'Applied',
  'Resume/cover letter prep': 'Applied',
  'Searched online': 'No suitable postings found',
}
const adding = ref(false)
const form = ref({ method: 'Attended interview' as EiMethod, activity: '', notes: '', outcome: 'Waiting on reply' as EiOutcome, time: '1 hour' as EiTimeSpent })
let manualN = 0

function setMethod(m: EiMethod) {
  form.value = { ...form.value, method: m, outcome: OUTCOME_FOR[m] }
}

function addManual() {
  const f = form.value
  if (!f.activity.trim()) return
  const key = `manual:${++manualN}`
  extras.value.push({
    key,
    date: today.value,
    method: f.method,
    activity: f.activity.trim(),
    subject: '',
    notes: f.notes.trim(),
    outcome: f.outcome,
    evidence: ['added by you'],
    alreadyLogged: false,
    sameDayLogged: sameDayFor(f.method),
    suggested: f.time,
    suggestedWhy: '',
  })
  hours.value = { ...hours.value, [key]: f.time }
  form.value = { method: 'Attended interview', activity: '', notes: '', outcome: 'Waiting on reply', time: '1 hour' }
  adding.value = false
}

// ---- Log ----

const busy = ref(false)
const result = ref<{ text: string; error: boolean } | null>(null)

async function logDay() {
  if (!ready.value.length || busy.value) return
  busy.value = true
  result.value = null
  const count = ready.value.length
  const total = totalText.value
  try {
    const res = await $fetch<EiWriteResult>('/api/ei/entries', {
      method: 'POST',
      body: {
        entries: ready.value.map((r) => ({
          date: r.date,
          method: r.method,
          activity: r.activity,
          notes: r.notes,
          outcome: r.outcome,
          timeSpent: hours.value[r.key],
        })),
      },
    })
    if (res.failed.length) {
      // Leave the failed rows on screen to retry, including any he typed in,
      // and drop the ones that did land so a second press cannot log them twice.
      const failed = new Set(res.failed.map((f) => f.activity))
      dropped.value = { ...dropped.value, ...Object.fromEntries(ready.value.filter((r) => !failed.has(r.activity)).map((r) => [r.key, true])) }
      result.value = { text: `${res.written} logged · ${res.failed.length} failed: ${res.failed[0]!.error}`, error: true }
      return
    }
    // Re-read so what was just written moves to "Already logged" and cannot
    // be logged twice by a second press.
    await load()
    result.value = { text: `Logged ${count} ${count === 1 ? 'entry' : 'entries'} (${total}) for ${dayTitle.value}.`, error: false }
  } catch (err: any) {
    result.value = { text: err?.data?.statusMessage || err?.message || "Couldn't write to the log", error: true }
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <PrimeButton label="Log EI time" icon="pi pi-calendar-clock" severity="secondary" outlined size="small" @click="show" />

  <PrimeDialog
    v-model:visible="open"
    modal
    :header="`Log EI time · ${dayTitle}`"
    :style="{ width: 'min(760px, 96vw)' }"
    :draggable="false"
    class="ei-day-dialog"
  >
    <div v-if="loading" class="ei-day-loading" aria-busy="true" aria-label="Reading today's activity">
      <div class="skel-panel sk" style="height: 64px" />
      <div class="skel-panel sk" style="height: 64px; animation-delay: 120ms" />
    </div>

    <PrimeMessage v-else-if="loadError" severity="error" :closable="false">{{ loadError }}</PrimeMessage>

    <template v-else-if="week">
      <p class="ei-day-lede">
        What the site saw you do today, with a suggested time on each. Change anything that is off, drop what did not
        happen, and add what it could not see. Nothing is logged until you press Log.
      </p>

      <PrimeMessage v-if="result" :severity="result.error ? 'error' : 'success'" :closable="false">{{ result.text }}</PrimeMessage>

      <div v-if="rows.length" class="ei-rows">
        <EiEntryRow
          v-for="r in rows"
          :key="r.key"
          v-model:hours="hours[r.key]"
          v-model:dropped="dropped[r.key]"
          :row="r"
        />
      </div>
      <div v-else class="ei-day-empty">
        <p class="ei-day-empty-lead">
          {{ loggedToday.length ? 'Everything the site saw today is already in the log.' : "The site didn't see any job-search activity from you today." }}
        </p>
        <p class="muted small">
          If you searched and nothing was worth applying to, that still counts — log it. If you did something off the
          site, add it.
        </p>
      </div>

      <!-- Adding what the site cannot see -->
      <div v-if="adding" class="ei-add editor">
        <div class="two">
          <label>
            <span>What kind</span>
            <PrimeSelect :model-value="form.method" :options="METHODS" size="small" @update:model-value="setMethod" />
          </label>
          <label>
            <span>Time spent</span>
            <PrimeSelect v-model="form.time" :options="EI_TIME_OPTIONS" size="small" />
          </label>
        </div>
        <label>
          <span>What you did</span>
          <PrimeInputText v-model="form.activity" size="small" placeholder="Interview with Stantec for Senior Software Developer" autocomplete="off" />
        </label>
        <div class="two">
          <label>
            <span>Outcome</span>
            <PrimeSelect v-model="form.outcome" :options="OUTCOMES" size="small" />
          </label>
          <label>
            <span>Notes <small>optional</small></span>
            <PrimeInputText v-model="form.notes" size="small" autocomplete="off" />
          </label>
        </div>
        <div class="ei-add-actions">
          <PrimeButton label="Cancel" severity="secondary" text size="small" @click="adding = false" />
          <PrimeButton label="Add row" icon="pi pi-plus" size="small" :disabled="!form.activity.trim()" @click="addManual" />
        </div>
      </div>

      <div class="ei-day-extras">
        <PrimeButton
          v-if="!hasSearchRow"
          label="Nothing suitable today"
          icon="pi pi-search"
          severity="secondary"
          outlined
          size="small"
          @click="nothingSuitable"
        />
        <PrimeButton v-if="!adding" label="Add something else" icon="pi pi-plus" severity="secondary" text size="small" @click="adding = true" />
      </div>

      <details v-if="loggedToday.length" class="ei-day-logged">
        <summary>Already logged today · {{ loggedToday.length }}</summary>
        <ul>
          <li v-for="(l, i) in loggedToday" :key="i">
            <span class="mono faint">{{ l.method }}</span> {{ l.activity }}
            <span class="mono">{{ l.timeSpent || '—' }}</span>
          </li>
        </ul>
      </details>
    </template>

    <template #footer>
      <NuxtLink to="/ei" class="ei-day-week" @click="open = false">The whole week <i class="pi pi-arrow-right" /></NuxtLink>
      <span v-if="ready.length" class="mono faint ei-day-total">{{ totalText }}</span>
      <PrimeButton label="Close" severity="secondary" text size="small" @click="open = false" />
      <PrimeButton
        :label="ready.length ? `Log ${ready.length} ${ready.length === 1 ? 'entry' : 'entries'}` : 'Nothing to log'"
        icon="pi pi-check"
        size="small"
        :disabled="!ready.length || loading"
        :loading="busy"
        @click="logDay"
      />
    </template>
  </PrimeDialog>
</template>
