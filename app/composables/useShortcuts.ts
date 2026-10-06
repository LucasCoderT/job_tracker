import { onMounted, onBeforeUnmount } from 'vue'

/**
 * Single-key shortcuts for a page.
 *
 * Three things stop a key from firing, and each is a way a shortcut would do
 * something he did not mean: he is typing (an input, a textarea, a select,
 * anything editable); a modifier is held (⌘K and Ctrl-F belong to the
 * browser); or a dialog or menu is open and owns the keyboard, where "a" is a
 * letter in a note and not "mark as applied".
 */
export function useShortcuts(keys: Record<string, () => void>) {
  function onKey(e: KeyboardEvent) {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return
    const t = e.target as HTMLElement | null
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return
    if (document.querySelector('.p-dialog-mask, .p-menu-overlay')) return
    const run = keys[e.key]
    if (!run) return
    e.preventDefault()
    run()
  }
  onMounted(() => window.addEventListener('keydown', onKey))
  onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
}
