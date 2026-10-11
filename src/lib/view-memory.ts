import { useCallback, useLayoutEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'

function read<T>(key: string, fallback: T): T {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(`chrysalis.view.${key}`) ?? 'null')
    if (value === null) return fallback
    if (Array.isArray(fallback)) return Array.isArray(value) && value.every((v) => typeof v === 'string') ? value as T : fallback
    if (fallback === null) return typeof value === 'string' ? value as T : fallback
    return typeof value === typeof fallback && (typeof value !== 'number' || Number.isFinite(value)) ? value as T : fallback
  } catch { return fallback }
}

function write(key: string, value: unknown) {
  try { sessionStorage.setItem(`chrysalis.view.${key}`, JSON.stringify(value)) } catch { /* storage unavailable */ }
}

export function useViewMemory<T>(key: string, fallback: T): [T, Dispatch<SetStateAction<T>>] {
  const [record, setRecord] = useState(() => ({ key, value: read(key, fallback) }))
  const value = record.key === key ? record.value : read(key, fallback)
  if (record.key !== key) setRecord({ key, value })
  const setValue = useCallback<Dispatch<SetStateAction<T>>>((next) => {
    setRecord((previous) => {
      const current = previous.key === key ? previous.value : read(key, fallback)
      const value = typeof next === 'function' ? (next as (value: T) => T)(current) : next
      write(key, value)
      return { key, value }
    })
  }, [key, fallback])
  return [value, setValue]
}

export function useViewScroll(key: string, enabled = true, page = false) {
  const root = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (!enabled) return
    const viewport = page ? root.current : root.current?.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]')
    if (!viewport) return
    const top = read(`${key}.scroll`, 0)
    let restoring = true
    let latestTop = top
    const save = () => { if (!restoring) { latestTop = viewport.scrollTop; write(`${key}.scroll`, latestTop) } }
    const restore = () => { viewport.scrollTop = top }
    restore()
    const frame = requestAnimationFrame(() => { restore(); restoring = false })
    viewport.addEventListener('scroll', save, { passive: true })
    return () => { cancelAnimationFrame(frame); viewport.removeEventListener('scroll', save); if (!restoring) write(`${key}.scroll`, latestTop) }
  }, [key, enabled, page])
  return root
}
