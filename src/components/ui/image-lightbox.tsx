import { useCallback, useEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react'
import { Minus, Plus, ArrowCounterClockwise, MagnifyingGlassPlus } from '@phosphor-icons/react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from './dialog'
import { Button } from './button'
import { proxyUrl } from '@/lib/engine'

type Point = { x: number; y: number }
type Transform = Point & { scale: number }
const INITIAL = { scale: 1, x: 0, y: 0 }

export function ImageLightbox({ open, onOpenChange, src, alt, remote = false, caption }: {
  open: boolean; onOpenChange: (open: boolean) => void; src: string; alt: string; remote?: boolean; caption?: string
}) {
  const [image, setImage] = useState('')
  const [error, setError] = useState('')
  const [transform, setTransform] = useState<Transform>(INITIAL)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [ratio, setRatio] = useState(1)
  const observer = useRef<ResizeObserver | null>(null)
  const current = useRef<Transform>(INITIAL)
  const pointers = useRef(new Map<number, Point>())
  useEffect(() => {
    if (!open) return
    current.current = INITIAL; setTransform(INITIAL); pointers.current.clear(); setError(''); setImage('')
    if (!remote) { setImage(src); return }
    let live = true, objectUrl = ''
    void fetch(proxyUrl(src)).then(response => {
      if (!response.ok) throw new Error(`Image request failed (${response.status})`)
      return response.blob()
    }).then(blob => {
      if (live) { objectUrl = URL.createObjectURL(blob); setImage(objectUrl) }
    }).catch(e => { if (live) setError(e instanceof Error ? e.message : String(e)) })
    return () => { live = false; if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [open, src, remote])
  const fit = { width: Math.min(size.width, size.height * ratio), height: Math.min(size.height, size.width / ratio) }
  const update = (next: Transform) => {
    const scale = Math.max(1, Math.min(5, next.scale))
    const boundX = Math.max(0, (fit.width * scale - size.width) / 2)
    const boundY = Math.max(0, (fit.height * scale - size.height) / 2)
    current.current = { scale, x: Math.max(-boundX, Math.min(boundX, next.x)), y: Math.max(-boundY, Math.min(boundY, next.y)) }
    setTransform(current.current)
  }
  const zoom = (scale: number, anchor: Point = { x: 0, y: 0 }) => {
    const previous = current.current, next = Math.max(1, Math.min(5, scale)), factor = next / previous.scale
    update({ scale: next, x: anchor.x - (anchor.x - previous.x) * factor, y: anchor.y - (anchor.y - previous.y) * factor })
  }
  const measure = useCallback((element: HTMLDivElement | null) => {
    observer.current?.disconnect()
    if (!element) return
    const resize = () => {
      setSize(previous => previous.width === element.clientWidth && previous.height === element.clientHeight ? previous : { width: element.clientWidth, height: element.clientHeight })
      current.current = INITIAL; setTransform(INITIAL)
    }
    resize()
    observer.current = new ResizeObserver(resize)
    observer.current.observe(element)
  }, [])
  const geometry = () => {
    const [a, b] = [...pointers.current.values()]
    return a && b ? { distance: Math.hypot(a.x - b.x, a.y - b.y), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : null
  }
  const move = (event: PointerEvent<HTMLDivElement>) => {
    const previous = pointers.current.get(event.pointerId)
    if (!previous) return
    const before = geometry()
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
    const after = geometry()
    if (before && after && before.distance > 0) {
      const rect = event.currentTarget.getBoundingClientRect()
      zoom(current.current.scale * after.distance / before.distance, { x: after.x - rect.left - rect.width / 2, y: after.y - rect.top - rect.height / 2 })
      update({ ...current.current, x: current.current.x + after.x - before.x, y: current.current.y + after.y - before.y })
    } else update({ ...current.current, x: current.current.x + event.clientX - previous.x, y: current.current.y + event.clientY - previous.y })
  }
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="image-lightbox">
      <DialogHeader><DialogTitle className="truncate pr-8 text-sm">{alt || 'Image'}</DialogTitle></DialogHeader>
      <div ref={measure} className="image-lightbox-viewport" data-zoomed={transform.scale > 1 || undefined}
        onPointerDown={event => { if (event.button !== 0) return; event.currentTarget.setPointerCapture(event.pointerId); pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY }) }}
        onPointerMove={move} onPointerUp={event => pointers.current.delete(event.pointerId)} onPointerCancel={event => pointers.current.delete(event.pointerId)} onLostPointerCapture={event => pointers.current.delete(event.pointerId)}
        onDoubleClick={event => { const rect = event.currentTarget.getBoundingClientRect(); zoom(current.current.scale > 1 ? 1 : 2, { x: event.clientX - rect.left - rect.width / 2, y: event.clientY - rect.top - rect.height / 2 }) }}>
        {error ? <p role="alert">{error}</p> : image ? <img src={image} alt={alt} draggable={false} onLoad={event => setRatio(event.currentTarget.naturalWidth / event.currentTarget.naturalHeight || 1)} onError={() => setError('Could not load the image.')} style={{ width: fit.width || '100%', height: fit.height || '100%', transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})` }} /> : <p role="status">Loading image…</p>}
      </div>
      <div className="image-lightbox-controls">
        <Button variant="ghost" size="icon" aria-label="Zoom out" disabled={transform.scale <= 1} onClick={() => zoom(transform.scale - 0.5)}><Minus /></Button>
        <span className="text-xs tabular-nums">{Math.round(transform.scale * 100)}%</span>
        <Button variant="ghost" size="icon" aria-label="Zoom in" disabled={transform.scale >= 5} onClick={() => zoom(transform.scale + 0.5)}><Plus /></Button>
        <Button variant="ghost" size="icon" aria-label="Reset zoom" onClick={() => update(INITIAL)}><ArrowCounterClockwise /></Button>
      </div>
      {caption && <p className="image-lightbox-caption">{caption}</p>}
    </DialogContent>
  </Dialog>
}

export function ImageLightboxTrigger({ src, alt, remote, children }: { src: string | null; alt: string; remote?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  return <>
    <button type="button" className="image-lightbox-trigger" disabled={!src} onClick={() => setOpen(true)} aria-label={`View ${alt} image`}>
      {children}<MagnifyingGlassPlus className="image-lightbox-badge" aria-hidden />
    </button>
    {src && <ImageLightbox open={open} onOpenChange={setOpen} src={src} alt={alt} remote={remote} />}
  </>
}
