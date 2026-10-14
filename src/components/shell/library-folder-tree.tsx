import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { CaretRight, FolderSimple, FolderOpen, FolderSimplePlus, FolderSimpleMinus, DotsSixVertical, Trash, DotsThree, SealCheck, MagnifyingGlass, PencilSimple, ArrowUp, ArrowDown } from '@phosphor-icons/react'
import { useApp } from '@/lib/store'
import { useViewMemory } from '@/lib/view-memory'
import { useTreeDrag } from '@/lib/tree-drag'
import { libraryOrder, placeInOrder, sortByOrder } from '@/lib/library-order'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useConfirm } from '@/components/ui/confirm'
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'

const NO_OPEN: string[] = []
const PAGE = 100
// Drop targets. An item lands on a zone (ROOT, NEW), `in:<folder>`,
// `at:<item>` (in front of it) or `end:<folder or ROOT>`; a folder lands in
// front of a folder id or at END.
const ROOT = ':root'
const NEW = ':new'
const END = ':end'
const LINE = 'pointer-events-none absolute inset-x-0 z-10 h-0.5 rounded-full bg-primary'

const ROW = 'group/row flex h-7 items-center rounded-md text-xs select-none [-webkit-touch-callout:none] max-md:h-9'
const ROW_MENU = 'size-6 shrink-0 text-muted-foreground opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100 max-md:opacity-100'

type Entry = { id: string; name: string; folderId: string | null }
type Source = { kind: 'item' | 'folder'; id: string; name: string; folderId: string | null }

function uniqueName(wanted: string, taken: string[]) {
  const used = new Set(taken.map((name) => name.toLowerCase()))
  if (!used.has(wanted.toLowerCase())) return wanted
  let n = 2
  while (used.has(`${wanted} ${n}`.toLowerCase())) n++
  return `${wanted} ${n}`
}

function FolderNameInput({ name, onDone }: { name: string; onDone: (name: string | null) => void }) {
  const ref = useRef<HTMLInputElement | null>(null)
  const mountedAt = useRef(performance.now())
  const settled = useRef(false)
  useEffect(() => { ref.current?.scrollIntoView({ block: 'nearest' }); ref.current?.focus(); ref.current?.select() }, [])
  const done = (value: string | null) => {
    if (settled.current) return
    settled.current = true
    onDone(value)
  }
  return <input
    ref={ref}
    data-no-drag
    defaultValue={name}
    aria-label="Folder name"
    className="h-6 min-w-0 flex-1 rounded-sm border border-ring bg-background px-1.5 text-xs outline-none max-md:h-7 max-md:text-base"
    onKeyDown={(e) => {
      if (e.key === 'Enter') done(e.currentTarget.value.trim() || null)
      if (e.key === 'Escape') done(null)
    }}
    onBlur={(e) => {
      // a menu that opened this input hands focus back to its own button as
      // it closes, just after the input mounts
      if (performance.now() - mountedAt.current < 400) { requestAnimationFrame(() => ref.current?.focus()); return }
      done(e.currentTarget.value.trim() || null)
    }}
  />
}

export function LibraryFolderTree<T extends Entry>({ scope, items, selectedId, activeId, onSelect, onMove, renderLabel, renderMenu }: {
  scope: 'presets' | 'lorebooks'
  items: T[]
  selectedId?: string | null
  /** the item in use; its folder is marked while the item itself is out of sight */
  activeId?: string | null
  onSelect: (id: string) => void
  onMove: (id: string, folderId: string | null) => void
  renderLabel: (item: T) => ReactNode
  /** menu items listed above the folder choices */
  renderMenu?: (item: T) => ReactNode
}) {
  const allFolders = useApp((s) => s.folders)
  const addFolder = useApp((s) => s.addFolder)
  const renameFolder = useApp((s) => s.renameFolder)
  const reorderFolders = useApp((s) => s.reorderFolders)
  const deleteFolder = useApp((s) => s.deleteFolder)
  const savedOrder = useApp((s) => s.settings.libraryOrder)
  const updateSettings = useApp((s) => s.updateSettings)
  const folders = allFolders.filter((f) => f.scope === scope)
  const sorted = sortByOrder(items, libraryOrder(savedOrder, scope))
  const [query, setQuery] = useViewMemory(`${scope}.search`, '')
  const [openIds, setOpenIds] = useViewMemory<string[]>(`${scope}.openFolders`, NO_OPEN, true)
  const [limits, setLimits] = useState<Record<string, number>>({})
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [confirm, confirmDialog] = useConfirm()
  const areaRef = useRef<HTMLDivElement | null>(null)
  const treeRef = useRef<HTMLUListElement | null>(null)

  const folderOf = (item: Entry) => (folders.some((f) => f.id === item.folderId) ? item.folderId : null)
  const openFolder = (id: string) => setOpenIds((ids) => (ids.includes(id) ? ids : [...ids, id]))
  const createFolder = (holding?: string) => {
    const id = addFolder(uniqueName('New folder', folders.map((f) => f.name)), scope)
    if (holding) { onMove(holding, id); openFolder(id) }
    setRenamingId(id)
  }
  const shiftFolder = (id: string, by: number) => {
    const ids = folders.map((f) => f.id)
    const from = ids.indexOf(id)
    const to = from + by
    if (from < 0 || to < 0 || to >= ids.length) return
    ids.splice(to, 0, ...ids.splice(from, 1))
    reorderFolders(scope, ids)
  }
  const removeFolder = async (id: string, name: string) => {
    const held = items.filter((item) => item.folderId === id)
    if (held.length && !await confirm({ title: `Delete ${name}?`, description: `Its ${held.length} ${held.length === 1 ? 'item stays' : 'items stay'} in your library.` })) return
    for (const item of held) onMove(item.id, null)
    deleteFolder(id)
  }

  const needle = query.trim().toLowerCase()
  const matches = (item: Entry, folderName = '') => !needle || `${item.name} ${folderName}`.toLowerCase().includes(needle)
  const groups = folders
    .map((folder) => {
      const held = sorted.filter((item) => item.folderId === folder.id)
      return { folder, total: held.length, active: held.some((item) => item.id === activeId), shown: held.filter((item) => matches(item, folder.name)) }
    })
    .filter((group) => !needle || group.shown.length > 0)
  const loose = sorted.filter((item) => !folderOf(item) && matches(item))
  const homeOf = (item: Entry) => folderOf(item) ?? ROOT
  /** ids of the rows a folder (or ROOT) is showing, top to bottom */
  const rowsIn = (home: string) => (home === ROOT ? loose : groups.find((group) => group.folder.id === home)?.shown ?? []).slice(0, limits[home] ?? PAGE).map((item) => item.id)
  /** the folder (or ROOT) an item drop target puts the item in */
  const homeOfTarget = (target: string) => {
    if (target === ROOT) return ROOT
    if (target.startsWith('in:')) return target.slice(3)
    if (target.startsWith('end:')) return target.slice(4)
    const item = items.find((entry) => entry.id === target.slice(3))
    return item ? homeOf(item) : null
  }

  const drag = useTreeDrag<Source>({
    resolve: (source, x, y) => {
      const hit = document.elementFromPoint(x, y)
      const area = areaRef.current
      const tree = treeRef.current
      if (!hit || !area || !tree || !area.contains(hit)) return null
      if (source.kind === 'item') {
        const zone = hit.closest<HTMLElement>('[data-drop-zone]')?.dataset.dropZone
        if (zone) return zone
        const from = source.folderId ?? ROOT
        const block = hit.closest<HTMLElement>('[data-folder]')
        const home = block?.dataset.folder ?? ROOT
        const row = hit.closest<HTMLElement>('[data-item]')
        const rows = rowsIn(home)
        if (!row) {
          // a folder's header or empty body takes the item; blank space under
          // the list is the end of the items without a folder
          if (block) return home === from ? null : `in:${home}`
          return from === ROOT && rows.at(-1) === source.id ? null : `end:${ROOT}`
        }
        const rect = row.getBoundingClientRect()
        const slot = rows.indexOf(row.dataset.item ?? '') + (y < rect.top + rect.height / 2 ? 0 : 1)
        const next = rows[slot]
        if (home === from && (next === source.id || rows[slot - 1] === source.id)) return null
        return next ? `at:${next}` : `end:${home}`
      }
      // a folder lands above the first header the pointer has not passed
      let before = END
      for (const block of Array.from(tree.querySelectorAll<HTMLElement>(':scope > [data-folder]'))) {
        const header = block.firstElementChild?.getBoundingClientRect()
        if (header && y < header.top + header.height / 2) { before = block.dataset.folder ?? END; break }
      }
      const ids = folders.map((f) => f.id)
      const after = ids[ids.indexOf(source.id) + 1] ?? END
      return before === source.id || before === after ? null : before
    },
    onDrop: (source, target) => {
      if (source.kind === 'item') {
        if (target === NEW) { createFolder(source.id); return }
        const home = homeOfTarget(target)
        if (!home) return
        const folderId = home === ROOT ? null : home
        if (folderId !== source.folderId) {
          onMove(source.id, folderId)
          if (folderId) openFolder(folderId)
        }
        const ids = sorted.map((item) => item.id)
        // past the last row on screen, or past everything in a folder dropped on
        const members = target.startsWith('end:') ? rowsIn(home) : sorted.filter((item) => homeOf(item) === home).map((item) => item.id)
        const last = members.filter((id) => id !== source.id).at(-1) ?? null
        const next = placeInOrder(ids, source.id, target.startsWith('at:') ? target.slice(3) : null, last)
        if (next.some((id, index) => id !== ids[index])) {
          updateSettings({ libraryOrder: { presets: libraryOrder(savedOrder, 'presets'), lorebooks: libraryOrder(savedOrder, 'lorebooks'), [scope]: next } })
        }
        return
      }
      const ids = folders.map((f) => f.id).filter((id) => id !== source.id)
      ids.splice(target === END ? ids.length : ids.indexOf(target), 0, source.id)
      reorderFolders(scope, ids)
    },
  })
  const dragged = drag.dragging
  const into = dragged?.kind === 'item' ? drag.target : null
  const before = dragged?.kind === 'folder' ? drag.target : null
  // where the dragged item would end up, when that is not where it is now
  const landing = into && into !== NEW ? homeOfTarget(into) : null
  const leaving = landing && landing !== (dragged?.folderId ?? ROOT) ? landing : null

  const itemRow = (item: T, index: number, list: T[]) => <li key={item.id} data-item={item.id} className="relative">
    {into === `at:${item.id}` && <div className={cn(LINE, '-top-px')} />}
    {into === `end:${homeOf(item)}` && index === list.length - 1 && <div className={cn(LINE, '-bottom-px')} />}
    <div
      className={cn(ROW, item.id === selectedId ? 'bg-accent' : 'hover:bg-accent/50', dragged?.id === item.id && 'cursor-grabbing opacity-40')}
      onPointerDown={(e) => drag.press({ kind: 'item', id: item.id, name: item.name, folderId: folderOf(item) }, e)}
    >
      <button type="button" title={item.name} onClick={() => onSelect(item.id)} className="flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-md pl-2 pr-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
        {renderLabel(item)}
      </button>
      <span data-no-drag className="flex">
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="ghost" size="icon-xs" className={ROW_MENU} aria-label={`Actions for ${item.name}`}><DotsThree className="size-4" aria-hidden="true" /></Button>} />
          <DropdownMenuContent align="end">
            {renderMenu?.(item)}
            {renderMenu && <DropdownMenuSeparator />}
            <DropdownMenuGroup>
              <DropdownMenuLabel>Move to</DropdownMenuLabel>
              {folders.map((folder) => <DropdownMenuItem key={folder.id} disabled={item.folderId === folder.id} onClick={() => { onMove(item.id, folder.id); openFolder(folder.id) }}>
                <FolderSimple className="size-4" aria-hidden="true" /><span className="truncate">{folder.name}</span>
              </DropdownMenuItem>)}
              {!!folderOf(item) && <DropdownMenuItem onClick={() => onMove(item.id, null)}><FolderSimpleMinus className="size-4" aria-hidden="true" />No folder</DropdownMenuItem>}
              <DropdownMenuItem onClick={() => createFolder(item.id)}><FolderSimplePlus className="size-4" aria-hidden="true" />New folder</DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </span>
    </div>
  </li>

  const more = (key: string, total: number) => total > (limits[key] ?? PAGE) && <li>
    <Button variant="ghost" size="xs" className="text-muted-foreground" onClick={() => setLimits((values) => ({ ...values, [key]: (values[key] ?? PAGE) + PAGE }))}>Show more</Button>
  </li>

  return <>
    <div className="flex items-center gap-1 border-b border-border p-1.5">
      <div className="relative min-w-0 flex-1">
        <MagnifyingGlass className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        <Input className="h-8 pl-7 md:h-7 md:text-xs" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search" aria-label={`Search ${scope}`} />
      </div>
      <Button variant="ghost" size="icon-sm" className="shrink-0" aria-label="New folder" title="New folder" onClick={() => { setQuery(''); createFolder() }}>
        <FolderSimplePlus className="size-4" aria-hidden="true" />
      </Button>
    </div>
    <div ref={areaRef} className="flex min-h-0 flex-1 flex-col">
      <ScrollArea className={cn('min-h-0 flex-1', leaving === ROOT && 'bg-primary/5')}>
        <ul ref={treeRef} className="flex flex-col p-1.5">
          {groups.map(({ folder, total, active, shown }, index) => {
            const open = !!needle || openIds.includes(folder.id)
            const Icon = open ? FolderOpen : FolderSimple
            const renaming = renamingId === folder.id
            return <li key={folder.id} data-folder={folder.id} className={cn('relative rounded-md', into === `in:${folder.id}` ? 'bg-primary/10 ring-1 ring-primary/60' : leaving === folder.id && 'bg-primary/5')}>
              <div
                className={cn(ROW, !renaming && 'hover:bg-accent/50', dragged?.id === folder.id && 'cursor-grabbing opacity-40')}
                onPointerDown={needle || renaming ? undefined : (e) => drag.press({ kind: 'folder', id: folder.id, name: folder.name, folderId: null }, e)}
              >
                {renaming
                  ? <div className="flex min-w-0 flex-1 items-center gap-1.5 pl-1.5 pr-1">
                    <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <FolderNameInput name={folder.name} onDone={(name) => {
                      setRenamingId(null)
                      if (name && name !== folder.name) renameFolder(folder.id, uniqueName(name, folders.filter((f) => f.id !== folder.id).map((f) => f.name)))
                    }} />
                  </div>
                  : <>
                    <button
                      type="button"
                      aria-expanded={open}
                      title={folder.name}
                      onClick={() => setOpenIds((ids) => (ids.includes(folder.id) ? ids.filter((id) => id !== folder.id) : [...ids, folder.id]))}
                      onDoubleClick={() => setRenamingId(folder.id)}
                      onKeyDown={(e) => { if (e.key === 'F2') setRenamingId(folder.id) }}
                      className="flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-md pl-1 pr-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                    >
                      <CaretRight className={cn('size-3 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} aria-hidden="true" />
                      <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                      <span className="min-w-0 flex-1 truncate font-medium">{folder.name}</span>
                      {active && <span title="Contains the one in use"><SealCheck className="size-3 shrink-0 text-primary" aria-label="Contains the one in use" /></span>}
                      <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">{total}</span>
                    </button>
                    <span data-no-drag className="flex">
                      <DropdownMenu>
                        <DropdownMenuTrigger render={<Button variant="ghost" size="icon-xs" className={ROW_MENU} aria-label={`Actions for folder ${folder.name}`}><DotsThree className="size-4" aria-hidden="true" /></Button>} />
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => setRenamingId(folder.id)}><PencilSimple className="size-4" aria-hidden="true" />Rename</DropdownMenuItem>
                          <DropdownMenuItem disabled={!!needle || index === 0} onClick={() => shiftFolder(folder.id, -1)}><ArrowUp className="size-4" aria-hidden="true" />Move up</DropdownMenuItem>
                          <DropdownMenuItem disabled={!!needle || index === groups.length - 1} onClick={() => shiftFolder(folder.id, 1)}><ArrowDown className="size-4" aria-hidden="true" />Move down</DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem className="text-destructive" onClick={() => void removeFolder(folder.id, folder.name)}><Trash className="size-4" aria-hidden="true" />Delete folder</DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </span>
                  </>}
              </div>
              {open && <ul className="ml-[11px] flex flex-col border-l border-border pl-1">
                {shown.slice(0, limits[folder.id] ?? PAGE).map(itemRow)}
                {!total && <li className="px-2 py-1 text-[11px] text-muted-foreground">Drop items here</li>}
                {more(folder.id, shown.length)}
              </ul>}
              {before === folder.id && <div className={cn(LINE, '-top-px')} />}
              {before === END && index === groups.length - 1 && <div className={cn(LINE, '-bottom-px')} />}
            </li>
          })}
          {loose.slice(0, limits[ROOT] ?? PAGE).map(itemRow)}
          {more(ROOT, loose.length)}
        </ul>
        {!groups.length && !loose.length && <p className="px-3 py-3 text-xs text-muted-foreground">{needle ? 'No matches' : 'Nothing here yet'}</p>}
      </ScrollArea>
      {dragged?.kind === 'item' && <div className="flex gap-1 border-t border-border p-1.5 text-xs">
        {dragged.folderId && <div data-drop-zone={ROOT} className={cn('flex h-8 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-md border border-dashed', into === ROOT ? 'border-primary bg-primary/10 text-foreground' : 'border-border text-muted-foreground')}>
          <FolderSimpleMinus className="size-4 shrink-0" aria-hidden="true" /><span className="truncate">No folder</span>
        </div>}
        <div data-drop-zone={NEW} className={cn('flex h-8 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-md border border-dashed', into === NEW ? 'border-primary bg-primary/10 text-foreground' : 'border-border text-muted-foreground')}>
          <FolderSimplePlus className="size-4 shrink-0" aria-hidden="true" /><span className="truncate">New folder</span>
        </div>
      </div>}
    </div>
    {dragged && createPortal(
      <div ref={drag.ghostRef} className="pointer-events-none fixed left-0 top-0 z-[200] flex h-7 max-w-52 items-center gap-1.5 rounded-md border border-border bg-popover px-2 text-xs text-popover-foreground shadow-lg">
        {dragged.kind === 'folder' ? <FolderSimple className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" /> : <DotsSixVertical className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
        <span className="truncate">{dragged.name}</span>
      </div>,
      document.body,
    )}
    {confirmDialog}
  </>
}
