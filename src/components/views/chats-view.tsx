
import { useEffect, useMemo, useState } from 'react'
import { MagnifyingGlass, Trash, DownloadSimple, GitBranch, Chats, PencilSimple, Plus, X, Folder as FolderIcon, DotsThree, SlidersHorizontal } from '@phosphor-icons/react'
import { Popover, PopoverContent, PopoverTrigger, PopoverTitle } from '@/components/ui/popover'
import { Input } from '@/components/ui/input'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { clampPage } from '@/components/ui/pager'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useApp } from '@/lib/store'
import { timeAgo } from '@/lib/tokens'
import { exportChatJSONL, exportChatTxt } from '@/lib/export'
import { createToast } from '@/lib/notifications'
import { searchChats } from '@/lib/engine'
import { searchHighlight, type ChatSearchMode, type ChatSearchPage } from '@/lib/chat-search'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { DEFAULT_AVATAR } from '@/lib/utils'

const toast = createToast('chat')
const CHAT_PAGE = 30

function SearchText({ text, query }: { text: string; query: string }) {
  return <>{searchHighlight(text, query).map((part, i) => part.matched ? <mark key={i} className="rounded-sm bg-primary/20 text-foreground">{part.text}</mark> : part.text)}</>
}

export function ChatsView() {
  const chats = useApp((s) => s.chats)
  const characters = useApp((s) => s.characters)
  const openChat = useApp((s) => s.openChat)
  const deleteChat = useApp((s) => s.deleteChat)
  const updateChat = useApp((s) => s.updateChat)
  const folders = useApp((s) => s.folders)
  const addFolder = useApp((s) => s.addFolder)
  const deleteFolder = useApp((s) => s.deleteFolder)
  const [query, setQuery] = useState('')
  const [searchMode, setSearchMode] = useState<ChatSearchMode>('all')
  const [characterId, setCharacterId] = useState<string | null>(null)
  const [searchPage, setSearchPage] = useState<ChatSearchPage | null>(null)
  const [searchBusy, setSearchBusy] = useState(false)
  const [searchError, setSearchError] = useState('')
  const [retry, setRetry] = useState(0)
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [renameId, setRenameId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [chatPage, setChatPage] = useState(0)
  const [activeFolderId, setActiveFolderId] = useState<string | null>(null)
  // In-app folder dialog — never a native window.prompt (user feedback).
  const [folderOpen, setFolderOpen] = useState(false)
  const [folderName, setFolderName] = useState('')

  const chatFolders = folders.filter((f) => f.scope === 'chats')

  const createFolder = () => {
    const name = folderName.trim()
    if (!name) return
    setActiveFolderId(addFolder(name, 'chats'))
    setFolderName('')
    setFolderOpen(false)
    toast.success(`Folder "${name}" created`)
  }

  const searching = query.trim().length > 0
  useEffect(() => {
    if (!searching) { setSearchPage(null); setSearchBusy(false); setSearchError(''); return }
    let alive = true
    const controller = new AbortController()
    setSearchBusy(true)
    setSearchPage(null)
    setSearchError('')
    const timer = setTimeout(() => {
      void searchChats({ query: query.trim(), mode: searchMode, folderId: activeFolderId, characterId, offset: chatPage * CHAT_PAGE, limit: CHAT_PAGE }, controller.signal)
        .then((page) => {
          if (!alive) return
          if (chatPage > 0 && chatPage * CHAT_PAGE >= page.total) setChatPage(Math.max(0, Math.ceil(page.total / CHAT_PAGE) - 1))
          else setSearchPage(page)
        })
        .catch((error: unknown) => { if (alive) setSearchError(error instanceof Error ? error.message : String(error)) })
        .finally(() => { if (alive) setSearchBusy(false) })
    }, 300)
    return () => { alive = false; clearTimeout(timer); controller.abort() }
  }, [query, searching, searchMode, activeFolderId, characterId, chatPage, retry, chats])

  const filtered = useMemo(() => [...chats]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .filter((c) => (!activeFolderId || c.folderId === activeFolderId) && (!characterId || c.characterId === characterId)), [chats, activeFolderId, characterId])
  const total = searching ? searchPage?.total ?? 0 : filtered.length
  const safePage = clampPage(chatPage, total, CHAT_PAGE)
  const paged = searching ? searchPage?.results.map((hit) => chats.find((c) => c.id === hit.chat.id) ?? hit.chat) ?? []
    : filtered.slice(safePage * CHAT_PAGE, (safePage + 1) * CHAT_PAGE)
  const hits = new Map(searchPage?.results.map((hit) => [hit.chat.id, hit]))

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* header + folder chips scroll WITH the list (mobile keyboard room) */}
      <ScrollArea className="min-h-0 flex-1">
      <header className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
        <h1 className="text-sm font-semibold">Chats <span className="ml-1 font-normal text-muted-foreground">{chats.length}</span></h1>
        <div className="flex w-full min-w-0 items-center gap-1.5 sm:ml-auto sm:w-auto sm:flex-1 sm:max-w-md">
          <div className="relative min-w-0 flex-1">
            <MagnifyingGlass className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input value={query} onChange={(e) => { setQuery(e.target.value); setChatPage(0) }} placeholder="Search chats…" maxLength={200} className="h-8 pl-8 pr-8 text-sm" aria-label="Search chats" />
            {query && <button type="button" className="absolute right-1 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring" aria-label="Clear search" onClick={() => { setQuery(''); setChatPage(0) }}><X className="size-3.5" aria-hidden="true" /></button>}
          </div>
          <Popover>
            <PopoverTrigger render={<Button variant="ghost" size="icon" className={`size-8 shrink-0 ${searchMode !== 'all' || characterId ? 'bg-primary/10 text-primary' : 'text-muted-foreground'}`} aria-label="Search filters" />}><SlidersHorizontal className="size-4" aria-hidden="true" /></PopoverTrigger>
            <PopoverContent align="end" className="gap-3 p-3">
              <PopoverTitle>Search filters</PopoverTitle>
              <label className="flex flex-col gap-1.5 text-xs text-muted-foreground">Search in
                <Select value={searchMode} onValueChange={(v) => { if (v) { setSearchMode(v as ChatSearchMode); setChatPage(0) } }}>
                  <SelectTrigger className="w-full" aria-label="Search in"><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="all">Names and messages</SelectItem><SelectItem value="messages">Messages only</SelectItem><SelectItem value="titles">Names and titles</SelectItem></SelectContent>
                </Select>
              </label>
              <label className="flex flex-col gap-1.5 text-xs text-muted-foreground">Character
                <Select value={characterId ?? 'all'} onValueChange={(v) => { setCharacterId(v === 'all' ? null : v); setChatPage(0) }}>
                  <SelectTrigger className="w-full" aria-label="Filter by character"><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="all">All characters</SelectItem>{characters.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}</SelectContent>
                </Select>
              </label>
              <p className="text-xs text-muted-foreground">Use quotes for an exact phrase.</p>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Button variant="ghost" size="sm" onClick={() => { setFolderName(''); setFolderOpen(true) }}><Plus className="size-3" aria-hidden="true" />New folder</Button>
                {(searchMode !== 'all' || characterId || activeFolderId) && <Button variant="ghost" size="sm" onClick={() => { setSearchMode('all'); setCharacterId(null); setActiveFolderId(null); setChatPage(0) }}>Reset filters</Button>}
              </div>
            </PopoverContent>
          </Popover>
        </div>
      </header>
      {(searchMode !== 'all' || characterId) && <div className="flex flex-wrap gap-1.5 px-4 pt-2">
        {searchMode !== 'all' && <Button variant="ghost" size="sm" className="h-6 gap-1 text-xs text-muted-foreground" onClick={() => { setSearchMode('all'); setChatPage(0) }}>{searchMode === 'messages' ? 'Messages only' : 'Names and titles'}<X className="size-3" aria-hidden="true" /></Button>}
        {characterId && <Button variant="ghost" size="sm" className="h-6 max-w-full gap-1 text-xs text-muted-foreground" onClick={() => { setCharacterId(null); setChatPage(0) }}><span className="truncate">{characters.find((c) => c.id === characterId)?.name ?? 'Character'}</span><X className="size-3 shrink-0" aria-hidden="true" /></Button>}
      </div>}
      {chatFolders.length > 0 && <div className="flex items-center gap-1.5 overflow-x-auto overscroll-x-contain border-b border-border px-4 py-2 [-webkit-overflow-scrolling:touch] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <button
          type="button"
          onClick={() => { setActiveFolderId(null); setChatPage(0) }}
          className={`shrink-0 rounded-full border px-2.5 py-1 text-xs ${!activeFolderId ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:text-foreground'}`}
        >
          All
        </button>
        {chatFolders.map((f) => (
          <span key={f.id} className="flex shrink-0 items-center">
            <button
              type="button"
              onClick={() => { setActiveFolderId(activeFolderId === f.id ? null : f.id); setChatPage(0) }}
              className={`flex items-center gap-1.5 rounded-full border py-1 pl-2.5 text-xs ${activeFolderId === f.id ? 'border-primary bg-primary/10 text-primary pr-1' : 'border-border text-muted-foreground hover:text-foreground pr-2.5'}`}
            >
              <FolderIcon className="size-3" style={{ color: f.color }} aria-hidden="true" />
              {f.name}
              <Badge variant="secondary" className="px-1 text-[10px]">{chats.filter((c) => c.folderId === f.id).length}</Badge>
              {activeFolderId === f.id && (
                <span
                  role="button"
                  tabIndex={0}
                  aria-label={`Delete folder ${f.name}`}
                  className="rounded-full p-0.5 hover:bg-accent"
                  onClick={(e) => { e.stopPropagation(); deleteFolder(f.id); setActiveFolderId(null); toast.success('Folder deleted') }}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); deleteFolder(f.id); setActiveFolderId(null) } }}
                >
                  <X className="size-3" aria-hidden="true" />
                </span>
              )}
            </button>
          </span>
        ))}
        <button
          type="button"
          onClick={() => { setFolderName(''); setFolderOpen(true) }}
          className="flex shrink-0 items-center gap-1 rounded-full border border-dashed border-border px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <Plus className="size-3" aria-hidden="true" /> New folder
        </button>
      </div>}

      <Dialog open={folderOpen} onOpenChange={setFolderOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>New chat folder</DialogTitle>
          </DialogHeader>
          <Input
            autoFocus
            value={folderName}
            onChange={(e) => setFolderName(e.target.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing || e.keyCode === 229) return
              if (e.key === 'Enter') { e.preventDefault(); createFolder() }
            }}
            placeholder="Folder name…"
            aria-label="Folder name"
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setFolderOpen(false)}>Cancel</Button>
            <Button onClick={createFolder} disabled={!folderName.trim()}>Create folder</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
        {searching && <div className="flex flex-wrap items-center gap-2 px-4 py-2 text-xs text-muted-foreground" role="status">
          {searchBusy ? 'Searching saved messages…' : searchError ? <><span className="text-destructive">{searchError}</span><Button variant="outline" size="sm" onClick={() => setRetry((n) => n + 1)}>Retry</Button></> : `${total} matching chat${total === 1 ? '' : 's'}`}
          {!!searchPage?.errors.length && <span className="text-destructive">{new Set(searchPage.errors.map((error) => error.chatId)).size} chat(s) could not be fully searched.</span>}
        </div>}
        {searching && (searchBusy || searchError) ? null : paged.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Chats aria-hidden="true" />
              </EmptyMedia>
              <EmptyTitle>No chats found</EmptyTitle>
              <EmptyDescription>Try a different search, or start a new chat from the Characters tab.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {paged.map((chat) => {
              const char = characters.find((c) => c.id === chat.characterId)
              const hit = hits.get(chat.id)
              const last = chat.messages[chat.messages.length - 1]
              // a chat whose transcript has not been loaded yet (list refresh,
              // never opened this session) carries its preview and size on the
              // list meta instead
              const loaded = chat.messages.length > 0
              const previewText = last?.swipes[last.activeSwipe]?.content ?? chat.preview ?? ''
              const msgCount = loaded ? chat.messages.length : chat.messageCount ?? 0
              return (
                <li key={chat.id} className="group flex flex-wrap items-center gap-3 px-4 py-2 hover:bg-accent/50">
                  <button type="button" onClick={() => openChat(chat.id)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
                    <Avatar className="size-9 rounded-md">
                      <AvatarImage src={char?.avatar || DEFAULT_AVATAR} alt="" />
                      <AvatarFallback>{char?.name.slice(0, 2)}</AvatarFallback>
                    </Avatar>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2 text-sm font-medium">
                        {char?.name}
                        <span className="text-muted-foreground">·</span>
                        <span className="truncate text-muted-foreground">{chat.title}</span>
                        {chat.branches.length > 0 && (
                          <Badge variant="outline" className="gap-1">
                            <GitBranch className="size-3" aria-hidden="true" />
                            {chat.branches.length}
                          </Badge>
                        )}
                        {chat.parentChatId && <Badge variant="outline">branch</Badge>}
                      </span>
                      <span className="line-clamp-1 text-xs text-muted-foreground">
                        {previewText.replace(/[*>#`]/g, '').slice(0, 120)}
                      </span>
                      {hit && hit.matchCount > 0 && <span className="block text-xs text-muted-foreground">{hit.matchCount} matching message{hit.matchCount === 1 ? '' : 's'}</span>}
                    </span>
                    <span className="flex shrink-0 flex-col items-end text-xs text-muted-foreground">
                      <span>{timeAgo(chat.updatedAt)}</span>
                      <span className="hidden sm:inline">{msgCount} msgs</span>
                    </span>
                  </button>
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={
                        <Button variant="ghost" size="sm" className="opacity-0 group-hover:opacity-100 max-sm:opacity-100" aria-label="Chat actions">
                          <DotsThree className="size-4" aria-hidden="true" />
                        </Button>
                      }
                    />
                    <DropdownMenuContent align="end">
                      <DropdownMenuGroup>
                        <DropdownMenuItem onClick={() => { setRenameId(chat.id); setRenameValue(chat.title) }}>
                          <PencilSimple className="size-4" aria-hidden="true" />
                          Rename
                        </DropdownMenuItem>
                        {chatFolders.length > 0 && (
                          <>
                            {chatFolders.map((f) => (
                              <DropdownMenuItem
                                key={f.id}
                                onClick={() => { updateChat(chat.id, { folderId: chat.folderId === f.id ? null : f.id }); toast.success(chat.folderId === f.id ? `Removed from ${f.name}` : `Moved to ${f.name}`) }}
                              >
                                <FolderIcon className="size-4" style={{ color: f.color }} aria-hidden="true" />
                                {chat.folderId === f.id ? `Remove from ${f.name}` : `Move to ${f.name}`}
                              </DropdownMenuItem>
                            ))}
                          </>
                        )}
                        <DropdownMenuItem onClick={() => { exportChatJSONL(chat, characters); toast.success('Exported as JSONL') }}>
                          <DownloadSimple className="size-4" aria-hidden="true" />
                          Export JSONL
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => { exportChatTxt(chat, characters); toast.success('Exported as TXT') }}>
                          <DownloadSimple className="size-4" aria-hidden="true" />
                          Export TXT
                        </DropdownMenuItem>
                        <DropdownMenuItem variant="destructive" onClick={() => setConfirmId(chat.id)}>
                          <Trash className="size-4" aria-hidden="true" />
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuGroup>
                    </DropdownMenuContent>
                  </DropdownMenu>
                  {hit && hit.snippets.length > 0 && <div className="flex w-full min-w-0 flex-col gap-1 pl-12">
                    {hit.snippets.slice(-1).map((snippet, i) => <button key={`${snippet.messageId}-${i}`} type="button" className="line-clamp-2 border-l-2 border-border pl-2 text-left text-xs text-muted-foreground hover:text-foreground" onClick={() => openChat(chat.id, snippet.messageId ?? undefined)}>
                      <span className="mr-1 font-medium">{snippet.role === 'user' ? 'You:' : snippet.role === 'system' ? 'System:' : `${char?.name ?? 'Reply'}:`}</span><SearchText text={snippet.text} query={query} />
                    </button>)}
                  </div>}
                </li>
              )
            })}
          </ul>
        )}

        {total > CHAT_PAGE && !searchBusy && (
          <div className="flex items-center justify-center gap-3 py-3 text-xs text-muted-foreground">
            <Button variant="outline" size="sm" className="h-7" disabled={safePage === 0} onClick={() => setChatPage((p) => p - 1)}>Previous</Button>
            <span>{safePage * CHAT_PAGE + 1}–{Math.min(total, (safePage + 1) * CHAT_PAGE)} of {total}</span>
            <Button variant="outline" size="sm" className="h-7" disabled={(safePage + 1) * CHAT_PAGE >= total} onClick={() => setChatPage((p) => p + 1)}>Next</Button>
          </div>
        )}
      </ScrollArea>

      <AlertDialog open={!!confirmId} onOpenChange={(o) => !o && setConfirmId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this chat?</AlertDialogTitle>
            <AlertDialogDescription>This permanently removes the chat and all its messages. This cannot be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (confirmId) deleteChat(confirmId)
                setConfirmId(null)
                toast.success('Chat deleted')
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={!!renameId} onOpenChange={(o) => !o && setRenameId(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Rename chat</DialogTitle>
          </DialogHeader>
          <Input value={renameValue} onChange={(e) => setRenameValue(e.target.value)} aria-label="Chat title" />
          <DialogFooter>
            <Button
              onClick={() => {
                if (renameId) updateChat(renameId, { title: renameValue })
                setRenameId(null)
                toast.success('Renamed')
              }}
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
