import { useEffect, useMemo, useRef, useState } from "react"
import { PencilSimple, Plus, Trash, FileText, FileCode, UploadSimple } from '@phosphor-icons/react'
import { createToast } from '@/lib/notifications'
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { useApp, chatPersonaId } from "@/lib/store"
import { saveFile } from "@/lib/export"
import { j } from "@/lib/engine"
import type { Chat, ID } from "@/lib/types"
import { cn } from "@/lib/utils"

const toast = createToast('chat')

function downloadText(text: string, filename: string, mime = "text/plain") {
  saveFile(new Blob([text], { type: mime }), filename)
}

const safeName = (name: string) => name.replace(/[^\w-]+/g, "_").replace(/^_+|_+$/g, "") || "chat"

/** Plain-text transcript: speaker-labeled blocks separated by blank lines. */
function chatToText(chat: Chat, charName: string, userName: string): string {
  const body = chat.messages
    .map((m) => `${m.role === "user" ? userName : charName}: ${m.swipes[m.activeSwipe]?.content ?? ""}`)
    .join("\n\n")
  return `# ${chat.title}\n\n${body}\n`
}

/** Interchange JSONL: a header line with both names, then one object per
 *  message (swipes carried, hidden messages flagged as system) — the same
 *  shape the importer rebuilds from. */
function chatToJsonl(chat: Chat, charName: string, userName: string): string {
  const lines = [
    JSON.stringify({ user_name: userName, character_name: charName }),
    ...chat.messages.map((m) => JSON.stringify({
      name: m.role === "user" ? userName : charName,
      is_user: m.role === "user",
      is_system: m.hidden === true,
      mes: m.swipes[m.activeSwipe]?.content ?? "",
      send_date: m.timestamp,
      swipes: m.swipes.map((sw) => sw.content),
      swipe_id: m.activeSwipe,
    })),
  ]
  return lines.join("\n") + "\n"
}

/** The chat's last visible line. Tagged blocks (thinking, panels) are
 *  skipped when prose remains outside them. */
function previewLine(chat: Chat): string {
  const last = [...chat.messages].reverse().find((m) => !m.hidden) ?? chat.messages[chat.messages.length - 1]
  // a chat whose transcript is not loaded falls back to the list meta's preview
  const text = last?.swipes[last.activeSwipe]?.content ?? chat.preview ?? ""
  const flat = (t: string) => t.replace(/<[^>]*>/g, " ").replace(/[*>#`]/g, " ").replace(/\s+/g, " ").trim()
  const outside = flat(text.replace(/<([\w~-]+)[^>]*>[\s\S]*?<\/\1\s*>/g, " "))
  return (outside || flat(text)).slice(0, 220)
}

/** Transcript length, or the list meta's count when it is not loaded. */
function msgCount(chat: Chat): number {
  return chat.messages.length > 0 ? chat.messages.length : chat.messageCount ?? 0
}

function fmtDate(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
}

/** Size of the chat's JSONL export — the real byte count of what
 *  "Export JSONL" downloads, not an estimate. */
function fmtSize(chat: Chat, charName: string, userName: string): string {
  const bytes = new Blob([chatToJsonl(chat, charName, userName)]).size
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`
}

function fmtRelative(ts: number): string {
  const mins = Math.round((Date.now() - ts) / 60000)
  if (mins < 1) return "just now"
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.round(hrs / 24)
  return days < 30 ? `${days}d ago` : fmtDate(ts)
}

function ChatRow({ chat, isCurrent, onOpen }: { chat: Chat; isCurrent: boolean; onOpen: () => void }) {
  const updateChat = useApp((s) => s.updateChat)
  const deleteChat = useApp((s) => s.deleteChat)
  const confirmDeletions = useApp((s) => s.settings.confirmDeletions)
  const characters = useApp((s) => s.characters)
  const personas = useApp((s) => s.personas)
  const personaName =
    personas.find((p) => p.id === chatPersonaId({ personas }, chat))?.name ?? "You"
  const charName = characters.find((c) => c.id === chat.characterId)?.name ?? "Character"
  const [renaming, setRenaming] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [draft, setDraft] = useState(chat.title)

  const commitRename = () => {
    const title = draft.trim()
    if (title && title !== chat.title) updateChat(chat.id, { title })
    setRenaming(false)
  }
  const count = msgCount(chat)
  const remove = () => { deleteChat(chat.id); toast.success("Chat deleted") }

  return (
    <div className={cn("rounded-md border px-2.5 py-2 transition-colors", isCurrent ? "border-primary/60 bg-accent/60" : "border-border hover:bg-accent/40")}>
      <div className="flex items-center gap-1.5">
        {renaming ? (
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing || e.keyCode === 229) return
              if (e.key === "Enter") commitRename()
              if (e.key === "Escape") { setDraft(chat.title); setRenaming(false) }
            }}
            autoFocus
            className="h-7 min-w-0 flex-1 text-sm"
            aria-label="Rename chat"
          />
        ) : (
          <button type="button" onClick={onOpen} className="min-w-0 flex-1 truncate text-left text-sm font-medium" aria-label={`Open chat ${chat.title}`}>
            {chat.title}
          </button>
        )}
        <Button variant="ghost" size="icon" className="size-7 shrink-0 text-muted-foreground" onClick={() => { setDraft(chat.title); setRenaming(true) }} aria-label={`Rename ${chat.title}`} title="Rename">
          <PencilSimple className="size-3.5" />
        </Button>
        <Button variant="ghost" size="icon" className="size-7 shrink-0 text-muted-foreground" onClick={() => downloadText(chatToJsonl(chat, charName, personaName), `${safeName(chat.title)}.jsonl`, "application/x-ndjson")} aria-label={`Export ${chat.title} as JSONL`} title="Export JSONL">
          <FileCode className="size-3.5" />
        </Button>
        <Button variant="ghost" size="icon" className="size-7 shrink-0 text-muted-foreground" onClick={() => downloadText(chatToText(chat, charName, personaName), `${safeName(chat.title)}.txt`)} aria-label={`Export ${chat.title} as plain text`} title="Export TXT">
          <FileText className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 shrink-0 text-muted-foreground hover:text-destructive"
          // the "confirm deletions" setting asks through an in-app dialog
          onClick={() => { if (confirmDeletions) setConfirmOpen(true); else remove() }}
          aria-label={`Delete ${chat.title}`}
          title="Delete"
        >
          <Trash className="size-3.5" />
        </Button>
      </div>
      <button type="button" onClick={onOpen} className="block w-full text-left" tabIndex={-1} aria-hidden="true">
        <p className="text-[11px] text-muted-foreground">
          <span title={fmtDate(chat.updatedAt)}>{fmtRelative(chat.updatedAt)}</span>
          {/* the size is measured off the transcript, so it waits for it to load */}
          {chat.messages.length > 0 && <>{" · "}{fmtSize(chat, charName, personaName)}</>}
          {" · "}{count} message{count === 1 ? "" : "s"}
        </p>
        <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-muted-foreground">{previewLine(chat) || "Empty chat"}</p>
      </button>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete &quot;{chat.title}&quot;?</AlertDialogTitle>
            <AlertDialogDescription>
              {count} message{count === 1 ? "" : "s"} will be removed. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={remove} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              Delete chat
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

export function ManageChatsDialog({
  open,
  onOpenChange,
  characterId,
  currentChatId,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  characterId: ID
  currentChatId: ID
}) {
  const chats = useApp((s) => s.chats)
  const characters = useApp((s) => s.characters)
  const startChatAndOpen = useApp((s) => s.startChatAndOpen)
  const openChat = useApp((s) => s.openChat)
  const hydrate = useApp((s) => s.hydrate)
  const chatFileRef = useRef<HTMLInputElement>(null)

  const character = characters.find((c) => c.id === characterId)

  // This list shows real previews, message counts and export sizes, all of
  // which need the transcripts — and chats arrive unloaded now. Pull this
  // character's when the dialog opens; ensureChatMessages is a no-op for any
  // chat already loaded, so reopening costs nothing.
  const ensureChatMessages = useApp((s) => s.ensureChatMessages)
  useEffect(() => {
    if (!open) return
    for (const c of useApp.getState().chats) {
      if (c.characterId === characterId) void ensureChatMessages(c.id)
    }
  }, [open, characterId, ensureChatMessages])

  // JSONL transcripts attach to THIS character (the importer links by name)
  const importChats = async (files: FileList | null) => {
    if (!files || !character) return
    for (const file of Array.from(files)) {
      try {
        const lines = (await file.text())
          .split("\n").filter((l) => l.trim())
          .map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
        if (!lines.length) { toast.error(`${file.name}: no messages found`); continue }
        const r = await j<{ chats: string[] }>("/import/batch", {
          method: "POST",
          body: JSON.stringify({ chats: [{ character: character.name, file: file.name.replace(/\.jsonl$/i, ""), lines }] }),
        })
        toast.success(`Imported to ${character.name} (${r.chats.length} new)`)
      } catch (e) { toast.error(`${file.name}: ${(e as Error).message ?? "could not parse JSONL"}`) }
    }
    await hydrate()
  }

  // every chat of this character, newest first; the search matches the
  // name and the last line
  const [query, setQuery] = useState("")
  const mine = useMemo(
    () => chats.filter((c) => c.characterId === characterId).sort((a, b) => b.updatedAt - a.updatedAt),
    [chats, characterId],
  )
  const q = query.trim().toLowerCase()
  const shown = q ? mine.filter((c) => c.title.toLowerCase().includes(q) || previewLine(c).toLowerCase().includes(q)) : mine

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85dvh] flex-col gap-3 sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-base">Chat files{character ? ` · ${character.name}` : ""}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            variant="outline"
            size="sm"
            className="gap-2"
            onClick={() => {
              void startChatAndOpen(characterId)
              onOpenChange(false)
            }}
          >
            <Plus className="size-4" /> New chat
          </Button>
          <input
            ref={chatFileRef}
            type="file"
            accept=".jsonl,.txt"
            multiple
            className="sr-only"
            onChange={(e) => { void importChats(e.target.files); e.target.value = "" }}
            aria-label="Import chat files"
          />
          <Button variant="outline" size="sm" className="gap-2" onClick={() => chatFileRef.current?.click()}>
            <UploadSimple className="size-4" /> Import chat
          </Button>
          <Input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search..."
            aria-label="Search chats"
            className="h-8 min-w-32 flex-1 text-sm"
          />
        </div>
        {/* max-h ON THE ROOT (not just the dialog): the dialog's height is
            content-sized up to a cap, and a percentage viewport height can't
            resolve against that — the viewport goes content-sized and never
            scrolls. A definite max-h here caps the viewport (max-h-[inherit])
            and scrolls; flex-1 keeps it shrinking with the dialog. */}
        <ScrollArea className="-mx-2 min-h-0 max-h-[62dvh] flex-1 px-2">
          <div className="flex flex-col gap-1.5 pb-1">
            {shown.map((c) => (
              <ChatRow key={c.id} chat={c} isCurrent={c.id === currentChatId} onOpen={() => { openChat(c.id); onOpenChange(false) }} />
            ))}
            {shown.length === 0 && (
              <p className="py-8 text-center text-sm text-muted-foreground">{q ? "No chats match" : "No chats yet for this character"}</p>
            )}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}
