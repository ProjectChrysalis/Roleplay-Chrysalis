import { useRef, useState } from 'react'
import { BookOpenText, Check, X } from '@phosphor-icons/react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { useApp } from '@/lib/store'
import type { ID } from '@/lib/types'
import { cn } from '@/lib/utils'

export function ChatLorebooks({ chatId, open, onOpenChange }: {
  chatId: ID; open: boolean; onOpenChange: (open: boolean) => void
}) {
  const chat = useApp((s) => s.chats.find((c) => c.id === chatId))
  const books = useApp((s) => s.lorebooks)
  const save = useApp((s) => s.setChatLorebooks)
  const [query, setQuery] = useState('')
  const [saving, setSaving] = useState(false)
  const busy = useRef(false)
  const selected = chat?.chatLorebookIds ?? []
  const matches = books.filter((book) => book.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  const visible = matches.slice(0, 60)
  const toggle = async (id: ID) => {
    if (busy.current) return
    busy.current = true
    setSaving(true)
    const ids = new Set(useApp.getState().chats.find((c) => c.id === chatId)?.chatLorebookIds ?? [])
    if (ids.has(id)) ids.delete(id); else ids.add(id)
    try { await save(chatId, [...ids]) }
    catch (e) { toast.error(e instanceof Error ? e.message : 'Could not save chat lore') }
    finally { busy.current = false; setSaving(false) }
  }
  return (
    <>
      <Button variant="outline" size="sm" className="h-8 shrink-0 gap-1 px-2 text-[11px]"
        aria-label={`Chat lorebooks, ${selected.length} selected`} onClick={() => onOpenChange(true)}>
        <BookOpenText className="size-3.5" aria-hidden="true" />
        Lore{selected.length > 0 && <span className="tabular-nums">{selected.length}</span>}
      </Button>
      <Dialog open={open} onOpenChange={(value) => { onOpenChange(value); if (!value) setQuery('') }}>
        <DialogContent className="min-w-0 overflow-hidden sm:max-w-md">
          <DialogHeader className="pr-8">
            <DialogTitle>Chat lorebooks</DialogTitle>
            <DialogDescription>Extra lore for this chat. Character, persona and global lore still apply.</DialogDescription>
          </DialogHeader>
          {selected.length > 0 && (
            <div className="flex max-h-24 flex-wrap gap-1.5 overflow-y-auto" aria-label="Selected lorebooks">
              {selected.map((id) => {
                const name = books.find((book) => book.id === id)?.name ?? 'Unavailable lorebook'
                return <Button key={id} variant="secondary" size="sm" disabled={saving}
                  className="h-7 max-w-full gap-1.5 text-xs" aria-label={`Remove ${name}`} onClick={() => void toggle(id)}>
                  <span className="min-w-0 truncate">{name}</span><X className="size-3 shrink-0" aria-hidden="true" />
                </Button>
              })}
            </div>
          )}
          <Command shouldFilter={false} className="min-h-0">
            <CommandInput placeholder="Search lorebooks…" value={query} onValueChange={setQuery} />
            <CommandList className="max-h-[min(18rem,40dvh)] overscroll-contain">
              <CommandEmpty>{books.length ? 'No matching lorebooks.' : 'Create or import a lorebook first.'}</CommandEmpty>
              {visible.map((book) => <CommandItem key={book.id} value={book.id} disabled={saving}
                onSelect={() => void toggle(book.id)} aria-label={`${book.name}, ${selected.includes(book.id) ? 'selected' : 'not selected'}`}>
                <Check className={cn('size-3.5 shrink-0', selected.includes(book.id) ? 'opacity-100' : 'opacity-0')} aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate">{book.name}</span>
              </CommandItem>)}
            </CommandList>
          </Command>
          {matches.length > visible.length && <p className="text-xs text-muted-foreground">{matches.length - visible.length} more, search to narrow.</p>}
        </DialogContent>
      </Dialog>
    </>
  )
}
