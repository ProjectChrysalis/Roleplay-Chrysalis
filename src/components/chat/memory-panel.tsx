import { useCallback, useEffect, useState } from 'react'
import { ArrowCounterClockwise, ArrowsClockwise, CaretDown, CircleNotch, PushPin, PushPinSlash, Sparkle, Trash } from '@phosphor-icons/react'
import { createToast } from '@/lib/notifications'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { Field, FieldLabel } from '@/components/ui/field'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { useApp } from '@/lib/store'
import { addMemory, deleteMemory, extractMemories, fetchMemories, updateMemory } from '@/lib/engine'
import type { Chat, MemoryEntry, SummaryPart } from '@/lib/types'
import { estimateTokens } from '@/lib/tokens'
import { cn } from '@/lib/utils'

const toast = createToast('memory')

const errText = (e: unknown) => String((e as Error)?.message ?? e)

/**
 * The chat's memory: the summaries that stand in for everything above the
 * cutoff, one per compacted stretch (compact / redo / undo), and the facts
 * kept for this chat.
 */
export function MemoryPanel({ chat, open, onOpenChange }: { chat: Chat; open: boolean; onOpenChange: (o: boolean) => void }) {
  const updateChat = useApp((s) => s.updateChat)
  const compactChat = useApp((s) => s.compactChat)
  const undoCompaction = useApp((s) => s.undoCompaction)
  const summaryCfg = useApp((s) => s.settings.summary)
  const updateSettings = useApp((s) => s.updateSettings)
  const [busy, setBusy] = useState<null | 'compact' | 'redo' | 'undo'>(null)

  const cutoffIdx = chat.memoryCutoffMessageId
    ? chat.messages.findIndex((m) => m.id === chat.memoryCutoffMessageId)
    : -1
  const summarized = cutoffIdx > 0 ? chat.messages.slice(0, cutoffIdx).filter((m) => !m.hidden).length : 0

  // One box per summary, oldest first. With none yet there is still one box:
  // typing in it writes the flat summary, which the engine keeps as a part.
  const parts = chat.summaryParts
  const shown = parts.length ? parts : [{ id: 's0', text: chat.summary }]
  const editPart = (i: number, text: string) => {
    if (!parts.length) { updateChat(chat.id, { summary: text }); return }
    const next = parts.map((p, k) => (k === i ? { ...p, text } : p))
    updateChat(chat.id, { summaryParts: next, summary: next.map((p) => p.text.trim()).filter(Boolean).join('\n\n') })
  }
  /** "Messages 1 to 40": where a summary's stretch sits in the chat today. */
  const stretch = (p: SummaryPart) => {
    if (!p.to) return ''
    const end = chat.messages.findIndex((m) => m.id === p.to)
    const start = p.from ? chat.messages.findIndex((m) => m.id === p.from) : 0
    return end > 0 && start >= 0 && end > start ? `Messages ${start + 1} to ${end}` : ''
  }
  const canRedo = !!parts[parts.length - 1]?.to

  const run = async (kind: 'compact' | 'redo' | 'undo') => {
    setBusy(kind)
    try {
      if (kind === 'undo') {
        await undoCompaction(chat.id)
        toast.success('Last compaction undone')
      } else {
        const r = await compactChat(chat.id, kind === 'redo' ? { redo: true } : undefined)
        toast.success(kind === 'redo' ? 'Summary rewritten' : `${r.covered} messages summarized`)
      }
    } catch (e) {
      toast.error(errText(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Memory</SheetTitle>
        </SheetHeader>
        <div className="flex flex-col gap-4 overflow-y-auto px-4 pb-4">
          <Field>
            <FieldLabel htmlFor="chat-summary-0">
              {parts.length > 1 ? 'Summaries' : 'Summary'} · {estimateTokens(shown.map((p) => p.text).join('\n\n'))} tokens
            </FieldLabel>
            {shown.map((part, i) => (
              <div key={i} className="flex flex-col gap-1">
                <Textarea
                  id={`chat-summary-${i}`}
                  rows={parts.length > 1 ? 5 : 10}
                  value={part.text}
                  onChange={(e) => editPart(i, e.target.value)}
                  placeholder="Nothing summarized yet. Compact writes a summary of the older messages here."
                  aria-label={parts.length > 1 ? `Summary ${i + 1} of ${parts.length}` : undefined}
                />
                {parts.length > 1 && (
                  <p className="text-[11px] text-muted-foreground">
                    {[stretch(part), part.merged ? `${part.merged} summaries merged` : ''].filter(Boolean).join(' · ') || 'Written by hand'}
                  </p>
                )}
              </div>
            ))}
            <p className="text-xs text-muted-foreground">
              {summarized > 0
                ? `${parts.length > 1 ? 'Together they stand' : 'Stands'} in for the ${summarized} messages above the cutoff. They stay in the chat but leave the prompt.`
                : 'Every message is still in the prompt.'}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" disabled={busy !== null} onClick={() => void run('compact')}>
                {busy === 'compact' ? <CircleNotch className="size-3.5 animate-spin" /> : <Sparkle className="size-3.5" />}
                Compact now
              </Button>
              <Button size="sm" variant="outline" disabled={busy !== null || !canRedo} onClick={() => void run('redo')}>
                {busy === 'redo' ? <CircleNotch className="size-3.5 animate-spin" /> : <ArrowsClockwise className="size-3.5" />}
                {parts.length > 1 ? 'Redo last' : 'Redo'}
              </Button>
              <Button size="sm" variant="outline" disabled={busy !== null || chat.compactions === 0} onClick={() => void run('undo')}>
                {busy === 'undo' ? <CircleNotch className="size-3.5 animate-spin" /> : <ArrowCounterClockwise className="size-3.5" />}
                Undo
              </Button>
            </div>
          </Field>

          <Field orientation="horizontal" className="rounded-md border border-border p-3">
            <div className="flex flex-col gap-0.5">
              <FieldLabel htmlFor="auto-compact">Compact automatically</FieldLabel>
              <p className="text-xs text-muted-foreground">
                When the chat outgrows the context, or every {summaryCfg.interval} messages. Keeps the last {summaryCfg.keepRecent}. Earlier summaries are left as written.
              </p>
            </div>
            <Switch
              id="auto-compact"
              checked={summaryCfg.mode === 'auto'}
              onCheckedChange={(v) => updateSettings({ summary: { ...summaryCfg, mode: v ? 'auto' : 'manual' } })}
            />
          </Field>

          <FactsSection chatId={chat.id} open={open} />
        </div>
      </SheetContent>
    </Sheet>
  )
}

/** Facts kept for this chat: pinned ones ride every prompt, the rest are
 *  recalled when the recent chat touches on them. */
function FactsSection({ chatId, open }: { chatId: string; open: boolean }) {
  const [facts, setFacts] = useState<MemoryEntry[] | null>(null)
  const [draft, setDraft] = useState('')
  const [extracting, setExtracting] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const load = useCallback(() => {
    void fetchMemories(chatId).then((r) => setFacts(r.memories)).catch(() => setFacts([]))
  }, [chatId])
  useEffect(() => { if (open) load() }, [open, load])
  const act = (p: Promise<unknown>) => void p.then(load).catch((e) => toast.error(errText(e)))

  return (
    <Collapsible open={expanded} onOpenChange={setExpanded} className="rounded-md border border-border">
      <CollapsibleTrigger className="flex w-full items-center gap-2 p-3 text-left text-sm font-medium">
        Facts
        <span className="text-xs font-normal text-muted-foreground">{facts === null ? '' : facts.length}</span>
        <CaretDown className={cn('ml-auto size-4 text-muted-foreground transition-transform', expanded && 'rotate-180')} />
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-2 px-3 pb-3">
        <p className="text-xs text-muted-foreground">Pinned facts ride every prompt. The rest come back when the chat uses their words. To keep a whole scene, use Save scene in a message's menu.</p>
        {facts?.map((m) => (
          <div key={m.id} className="flex items-start gap-1.5 rounded-md border border-border p-2">
            <p className="min-w-0 flex-1 text-xs leading-relaxed">{m.text}</p>
            <Button variant="ghost" size="icon-sm" aria-label={m.pinned ? 'Unpin fact' : 'Pin fact'} onClick={() => act(updateMemory(chatId, m.id, { pinned: !m.pinned }))}>
              {m.pinned ? <PushPin weight="fill" className="size-3.5" /> : <PushPinSlash className="size-3.5" />}
            </Button>
            <Button variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-destructive" aria-label="Delete fact" onClick={() => act(deleteMemory(chatId, m.id))}>
              <Trash className="size-3.5" />
            </Button>
          </div>
        ))}
        <div className="flex gap-2">
          <Textarea rows={2} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="A fact worth keeping…" className="min-h-0 text-xs" aria-label="New fact" />
          <div className="flex flex-col gap-1">
            <Button size="sm" variant="outline" className="h-7 text-xs" disabled={!draft.trim()} onClick={() => { act(addMemory(chatId, draft.trim())); setDraft('') }}>
              Add
            </Button>
            <Button
              size="sm" variant="outline" className="h-7 text-xs" disabled={extracting}
              onClick={() => {
                setExtracting(true)
                void extractMemories(chatId)
                  .then((r) => { toast.success(`${r.added.length} fact${r.added.length === 1 ? '' : 's'} found`); load() })
                  .catch((e) => toast.error(errText(e)))
                  .finally(() => setExtracting(false))
              }}
            >
              {extracting ? <CircleNotch className="size-3.5 animate-spin" /> : <Sparkle className="size-3.5" />}
              Find
            </Button>
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
