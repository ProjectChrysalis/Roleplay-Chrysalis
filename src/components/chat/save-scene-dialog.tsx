import { useEffect, useState } from 'react'
import { CircleNotch, Minus, Plus, Sparkle } from '@phosphor-icons/react'
import { createToast } from '@/lib/notifications'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useApp } from '@/lib/store'
import { draftScene } from '@/lib/engine'
import type { Chat, ID } from '@/lib/types'

const toast = createToast('lorebooks')

const NEW_BOOK = 'new'
/** How far back a scene starts by default, counted from the picked message. */
const DEFAULT_SPAN = 12

/**
 * Keep a scene as a lorebook entry: pick the stretch that ends at a message,
 * let the model draft the entry (or write it by hand), edit, save. The entry
 * lands in a lorebook this chat reads, so its keys bring it back later.
 */
export function SaveSceneDialog({ chat, messageId, open, onOpenChange }: {
  chat: Chat; messageId: ID; open: boolean; onOpenChange: (open: boolean) => void
}) {
  const books = useApp((s) => s.lorebooks)
  const model = useApp((s) => s.model)
  const saveSceneEntry = useApp((s) => s.saveSceneEntry)
  const messages = chat.messages
  const picked = Math.max(0, messages.findIndex((m) => m.id === messageId))
  const [from, setFrom] = useState(0)
  const [to, setTo] = useState(0)
  const [title, setTitle] = useState('')
  const [keys, setKeys] = useState('')
  const [content, setContent] = useState('')
  const [bookId, setBookId] = useState<string>(NEW_BOOK)
  const [busy, setBusy] = useState<null | 'draft' | 'save'>(null)
  // the chat's own lorebooks come first: a scene belongs with the others
  const chatBooks = (chat.chatLorebookIds ?? []).map((id) => books.find((b) => b.id === id)).filter((b) => !!b)

  // every opening starts fresh, ending at the message it was opened from
  useEffect(() => {
    if (!open) return
    setTo(picked)
    setFrom(Math.max(0, picked - DEFAULT_SPAN + 1))
    setTitle(''); setKeys(''); setContent('')
    setBookId(chatBooks[0]?.id ?? NEW_BOOK)
    // only when it opens: the books and messages changing under an open
    // dialog must not wipe what was typed
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, messageId])

  const count = messages.slice(from, to + 1).filter((m) => !m.hidden && m.role !== 'system').length
  const preview = (i: number) => {
    const m = messages[i]
    if (!m) return ''
    const text = (m.swipes[m.activeSwipe]?.content ?? '').replace(/\s+/g, ' ').trim()
    return text.length > 70 ? `${text.slice(0, 70)}…` : text
  }

  const draft = async () => {
    const a = messages[from], z = messages[to]
    if (!a || !z) return
    setBusy('draft')
    try {
      const r = await draftScene(chat.id, a.id, z.id, model)
      setTitle(r.draft.title)
      setKeys(r.draft.keys.join(', '))
      setContent(r.draft.content)
    } catch (e) {
      toast.error(String((e as Error)?.message ?? e))
    } finally {
      setBusy(null)
    }
  }
  const save = async () => {
    setBusy('save')
    try {
      const keyList = [...new Set(keys.split(',').map((k) => k.trim()).filter(Boolean))]
      const id = await saveSceneEntry(chat.id, { title: title.trim() || 'Scene', keys: keyList, content: content.trim() }, bookId === NEW_BOOK ? null : bookId)
      const name = useApp.getState().lorebooks.find((b) => b.id === id)?.name ?? 'the lorebook'
      toast.success(`Scene saved to ${name}`)
      onOpenChange(false)
    } catch (e) {
      toast.error(String((e as Error)?.message ?? e))
    } finally {
      setBusy(null)
    }
  }

  const stepper = (label: string, value: number, set: (n: number) => void, min: number, max: number) => (
    <div className="flex items-center gap-2">
      <span className="w-12 shrink-0 text-xs text-muted-foreground">{label}</span>
      <Button variant="outline" size="icon-sm" aria-label={`${label} one message earlier`} disabled={value <= min} onClick={() => set(value - 1)}>
        <Minus className="size-3.5" aria-hidden="true" />
      </Button>
      <Button variant="outline" size="icon-sm" aria-label={`${label} one message later`} disabled={value >= max} onClick={() => set(value + 1)}>
        <Plus className="size-3.5" aria-hidden="true" />
      </Button>
      <p className="min-w-0 flex-1 truncate text-xs">
        <span className="text-muted-foreground">#{value} </span>{preview(value)}
      </p>
    </div>
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="min-w-0 sm:max-w-lg">
        <DialogHeader className="pr-8">
          <DialogTitle>Save scene</DialogTitle>
          <DialogDescription>Keeps this stretch as a lorebook entry. Its keys bring it back when the story touches on it again.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5 rounded-md border border-border p-2.5">
            {stepper('From', from, setFrom, 0, to)}
            {stepper('To', to, setTo, from, messages.length - 1)}
            <div className="flex items-center justify-between gap-2 pt-1">
              <span className="text-xs text-muted-foreground">{count} message{count === 1 ? '' : 's'}</span>
              <Button size="sm" variant="outline" disabled={busy !== null || count === 0} onClick={() => void draft()}>
                {busy === 'draft' ? <CircleNotch className="size-3.5 animate-spin" aria-hidden="true" /> : <Sparkle className="size-3.5" aria-hidden="true" />}
                {content.trim() ? 'Draft again' : 'Draft it'}
              </Button>
            </div>
          </div>
          <Field>
            <FieldLabel htmlFor="scene-title">Title</FieldLabel>
            <Input id="scene-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Scene" />
          </Field>
          <Field>
            <FieldLabel htmlFor="scene-keys">Keys</FieldLabel>
            <Input id="scene-keys" value={keys} onChange={(e) => setKeys(e.target.value)} placeholder="names, places, objects" />
            <p className="text-[11px] text-muted-foreground">Separated by commas. With no keys the entry never comes back on its own.</p>
          </Field>
          <Field>
            <FieldLabel htmlFor="scene-content">Entry</FieldLabel>
            <Textarea id="scene-content" rows={6} value={content} onChange={(e) => setContent(e.target.value)} placeholder="Draft it, or write what happened yourself." />
          </Field>
          <Field>
            <FieldLabel>Lorebook</FieldLabel>
            <Select value={bookId} onValueChange={(v) => v && setBookId(v)}>
              <SelectTrigger aria-label="Lorebook"><SelectValue /></SelectTrigger>
              <SelectContent>
                {chatBooks.map((b) => <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)}
                <SelectItem value={NEW_BOOK}>A new lorebook for this chat</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={busy !== null || !content.trim()} onClick={() => void save()}>
            {busy === 'save' && <CircleNotch className="size-3.5 animate-spin" aria-hidden="true" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
