/**
 * Pure helpers over the bank shape, shared by the Worker (validation, lint,
 * Notion write-back) and the editor in the browser (parsing the beat lines
 * as they are typed). Ports of InterviewHelper's own Scripts/sync_bank.py
 * and Core/BankLint.swift — keep the rules in step by hand; every one
 * traces to an observed failure in a real interview, not taste.
 */
import type { Answer, AnswerBank, Beat } from './types'

export function slugify(text: string, max = 60): string {
  return (
    String(text || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, max) || 'interview'
  )
}

function strings(v: any): string[] {
  if (!Array.isArray(v)) return []
  return v.map((s) => String(s ?? '').trim()).filter(Boolean)
}

export function cleanAnswer(a: any): Answer {
  if (!a || typeof a !== 'object') throw new Error('An answer is an object')
  const question = String(a.question ?? '').trim()
  if (!question) throw new Error('An answer needs a question')
  const id = slugify(String(a.id ?? '').trim() || question, 40)
  const beats: Beat[] = Array.isArray(a.beats)
    ? a.beats
        .map((b: any) => {
          const text = String(b?.text ?? '').trim()
          if (!text) return null
          const beat: Beat = { text, keys: strings(b?.keys) }
          const stance = String(b?.stance ?? '').toUpperCase()
          if (['DELIBERATE', 'GAP', 'MEASURED', 'UNMEASURED'].includes(stance)) beat.stance = stance
          return beat
        })
        .filter(Boolean)
    : []
  const answer: Answer = { id, question, cues: strings(a.cues), beats }
  const script = typeof a.script === 'string' ? a.script.trim() : ''
  if (script) answer.script = script
  const avoid = strings(a.avoid)
  if (avoid.length) answer.avoid = avoid
  const floor = Number(a.minSeconds)
  if (Number.isFinite(floor) && floor > 0) answer.minSeconds = Math.round(floor)
  return answer
}

export function cleanBank(input: any): AnswerBank {
  if (!input || typeof input !== 'object' || !Array.isArray(input.answers)) {
    throw new Error('A bank is {"title"?, "answers": [...]}')
  }
  const seen = new Set<string>()
  const answers = input.answers.map((a: any) => {
    const answer = cleanAnswer(a)
    if (seen.has(answer.id)) throw new Error(`Duplicate answer id "${answer.id}"`)
    seen.add(answer.id)
    return answer
  })
  const bank: AnswerBank = { answers }
  if (typeof input.title === 'string' && input.title.trim()) bank.title = input.title.trim()
  const avoid = strings(input.avoid)
  if (avoid.length) bank.avoid = avoid
  if (Array.isArray(input.presentation)) {
    const sections = input.presentation
      .filter((s: any) => s && typeof s.answerId === 'string')
      .map((s: any) => ({ answerId: s.answerId, budgetSeconds: Math.max(0, Math.round(Number(s.budgetSeconds) || 0)) }))
    if (sections.length) bank.presentation = sections
  }
  return bank
}

// ---- Beat lines (the Notion / editor format) ----
//
//   Rolled back first, debugged second [DELIBERATE] :: rolled back, revert

const STANCE_RE = /\s*\[(DELIBERATE|GAP|MEASURED|UNMEASURED)\]\s*$/i

export function parseBeats(raw: string): Beat[] {
  const beats: Beat[] = []
  for (let line of String(raw || '').split('\n')) {
    line = line.trim().replace(/^[-•*\s]+/, '').trim()
    if (!line) continue
    let text = line
    let keys: string[] = []
    const i = line.indexOf('::')
    if (i >= 0) {
      text = line.slice(0, i)
      keys = line
        .slice(i + 2)
        .split(',')
        .map((k) => k.trim())
        .filter(Boolean)
    }
    text = text.trim()
    const beat: Beat = { text, keys }
    const m = STANCE_RE.exec(text)
    if (m) {
      beat.stance = m[1]!.toUpperCase()
      beat.text = text.slice(0, m.index).trim()
    }
    if (beat.text) beats.push(beat)
  }
  return beats
}

export function beatsToLines(beats: Beat[]): string {
  return beats
    .map((b) => {
      const stance = b.stance ? ` [${b.stance}]` : ''
      const keys = b.keys?.length ? ` :: ${b.keys.join(', ')}` : ''
      return `${b.text}${stance}${keys}`
    })
    .join('\n')
}

export function splitList(raw: string): string[] {
  return String(raw || '')
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
}

// ---- Lint ----

export function lintAnswer(a: Answer, cueOwner?: Map<string, string>): string[] {
  const issues: string[] = []
  const aid = a.id
  if (!a.cues?.length) issues.push(`[${aid}] no cues — can only be reached from the picker`)
  if (!a.beats?.length) issues.push(`[${aid}] no beats — an empty card`)
  if (a.beats?.length > 6) issues.push(`[${aid}] ${a.beats.length} beats — more than the card fits`)
  for (const cue of a.cues ?? []) {
    const c = cue.toLowerCase().trim()
    const owner = cueOwner?.get(c)
    if (owner && owner !== aid) {
      issues.push(`[${aid}] cue '${cue}' also belongs to '${owner}' — whichever card wins is arbitrary`)
    }
    cueOwner?.set(c, aid)
  }
  for (const beat of a.beats ?? []) {
    if (!beat.keys?.length) issues.push(`[${aid}] beat '${beat.text}' has no keys — it can never tick`)
    if (beat.text.split(/\s+/).length > 8) {
      issues.push(`[${aid}] beat '${beat.text}' is over 8 words — it will be read aloud`)
    }
    for (const key of beat.keys ?? []) {
      if (key.toLowerCase().replace(/[^a-z0-9]/g, '').length < 4) {
        issues.push(`[${aid}] key '${key}' is very short — prefix matching over-ticks`)
      }
    }
  }
  return issues
}

export function lint(bank: AnswerBank | null): string[] {
  if (!bank) return []
  const cueOwner = new Map<string, string>()
  const issues = bank.answers.flatMap((a) => lintAnswer(a, cueOwner))
  for (const s of bank.presentation ?? []) {
    if (!bank.answers.some((a) => a.id === s.answerId)) {
      issues.push(`[deck] section '${s.answerId}' names no answer in this bank`)
    }
  }
  return issues
}
