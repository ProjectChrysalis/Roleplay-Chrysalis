import { useEffect, useRef, useState } from 'react'
import { j } from '@/lib/engine'
import { useApp, chatPresetId } from '@/lib/store'
import { createToast } from '@/lib/notifications'
import { formatCost } from '@/lib/tokens'
import { Button } from '@/components/ui/button'

const toast = createToast('cache')
interface RefreshStatus {
  enabled: boolean
  state: string
  message: string
  nextAt?: number | null
  remaining?: number
  now: number
  events?: { at: number; id: string; message: string; type: 'success' | 'warning'; notify: boolean }[]
  usage?: { input: number; output: number; cacheRead?: number; cacheWrite?: number; costTotal?: number }[]
}

export function CacheRefreshStatus({ chatId }: { chatId: string }) {
  const [status, setStatus] = useState<RefreshStatus | null>(null)
  const [now, setNow] = useState(Date.now())
  const [error, setError] = useState('')
  const serverOffset = useRef(0)
  const busy = useApp((s) => !!s.streaming)
  const config = useApp((s) => {
    const chat = s.chats.find((c) => c.id === chatId)
    return s.presets.find((p) => p.id === (chat ? chatPresetId(s, chat) : null))?.samplers.cache.refresh
  })
  const enabled = config?.enabled === true
  const poll = useRef<((stop?: boolean) => Promise<void>) | null>(null)
  useEffect(() => {
    if (!enabled) return
    const clientId = `refresh_${crypto.randomUUID()}`
    let alive = true
    let running = false
    let revision = 0
    let active: AbortController | null = null
    const mountedAt = Date.now()
    const seen = new Set<string>()
    setStatus(null)
    setError('')
    const update = async (stop = false) => {
      if (running && !stop) return
      if (stop) active?.abort()
      const controller = new AbortController()
      active = controller
      running = true
      const current = ++revision
      try {
        const r = await j<RefreshStatus>('/cache-refresh', { method: 'POST', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]), body: JSON.stringify({ clientId, chatId, busy: !!useApp.getState().streaming, stop }) })
        if (!alive || current !== revision) return
        setError('')
        serverOffset.current = r.now - Date.now()
        setStatus(r)
        for (const event of r.events ?? []) {
          if (seen.has(event.id)) continue
          seen.add(event.id)
          if (event.notify && event.at >= mountedAt + serverOffset.current) toast[event.type](event.message)
        }
      } catch (e) { if (alive && current === revision) setError(e instanceof Error ? e.message : 'Cache refresh unavailable') }
      finally { if (current === revision) running = false }
    }
    poll.current = update
    void update()
    const heartbeat = setInterval(() => void update(), 15_000)
    const clock = setInterval(() => setNow(Date.now() + serverOffset.current), 1000)
    const resume = () => { if (document.visibilityState === 'visible') void update() }
    document.addEventListener('visibilitychange', resume)
    return () => {
      alive = false
      active?.abort()
      poll.current = null
      clearInterval(heartbeat)
      clearInterval(clock)
      document.removeEventListener('visibilitychange', resume)
      void j('/cache-refresh', { method: 'POST', signal: AbortSignal.timeout(10_000), body: JSON.stringify({ clientId, chatId: null }) }).catch(() => {})
    }
  }, [chatId, enabled])
  useEffect(() => { void poll.current?.() }, [busy, config])
  if (!enabled) return null
  const usage = status?.usage ?? []
  const cost = usage.length && usage.every((u) => u.costTotal != null) ? usage.reduce((total, u) => total + u.costTotal!, 0) : null
  const tokens = usage.reduce((total, u) => total + u.input + u.output + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0), 0)
  return (
    <div className="relative flex shrink-0 flex-wrap items-center justify-end gap-2 border-b px-3 py-1 text-xs text-muted-foreground" aria-live="polite">
      <span>{error || (busy ? 'Cache refresh paused while generating' : status?.nextAt ? `Cache refresh in ${Math.max(0, Math.ceil((status.nextAt - now) / 1000))}s · ${status.remaining} left` : status?.message || 'Waiting for cache refresh status')}</span>
      {usage.length > 0 && <span title="Refresh usage, separate from reply generation">{tokens.toLocaleString()} tokens · {cost != null ? formatCost(cost) : 'Cost unknown'}</span>}
      {status?.state === 'scheduled' && <Button variant="ghost" size="sm" className="h-5 px-1 text-xs" onClick={() => void poll.current?.(true)}>Stop</Button>}
    </div>
  )
}
