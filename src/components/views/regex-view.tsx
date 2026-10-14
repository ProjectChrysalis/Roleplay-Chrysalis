
import { useViewMemory } from '@/lib/view-memory'
import { useEffect, useRef, useState } from "react"
import { Plus, Trash, CaretRight, DotsThreeVertical, ToggleLeft, ToggleRight, UploadSimple, DownloadSimple, Flask, X } from '@phosphor-icons/react'
import { createToast } from '@/lib/notifications'
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Badge } from "@/components/ui/badge"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { useApp } from "@/lib/store"
import { regexImport, regexExport, downloadJson } from "@/lib/interop"
import { uid } from "@/lib/tokens"
import type { RegexScript } from "@/lib/types"
import { cn } from "@/lib/utils"
import { MasterDetail } from "@/components/shell/master-detail"
import { RegexImportChoice } from '@/components/regex/import-choice-dialog'
import { useConfirm } from '@/components/ui/confirm'
import { runRegexSafe, type SafeRegexResult } from '@/lib/safe-regex'

const toast = createToast('regex')

const PLACEMENTS: [keyof RegexScript["placements"], string][] = [
  ["userInput", "User input"],
  ["aiOutput", "AI output"],
  ["slash", "Slash commands"],
  ["wi", "World info"],
  ["reasoning", "Reasoning"],
]

// one list section per scope, in the order scripts usually matter
const SCOPES: { scope: RegexScript["scope"]; label: string; hint: string; unassigned: string }[] = [
  { scope: "global", label: "Global", hint: "Runs in every chat", unassigned: "" },
  { scope: "preset", label: "Preset", hint: "Runs while its preset is in use", unassigned: "No preset picked" },
  { scope: "character", label: "Character", hint: "Runs in chats with its character", unassigned: "No character picked" },
  { scope: "chat", label: "Chat", hint: "Runs in one chat only", unassigned: "No chat picked" },
]

type Owner = { key: string; name: string; active: boolean; assigned: boolean; scripts: RegexScript[] }

function byFolder(scripts: RegexScript[]) {
  const folders = new Map<string, RegexScript[]>()
  for (const script of scripts) {
    const name = script.folder?.trim() || ""
    folders.set(name, [...(folders.get(name) ?? []), script])
  }
  // loose scripts first, then folders by name
  return [...folders].sort(([a], [b]) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b)))
}

function Tally({ scripts }: { scripts: RegexScript[] }) {
  return <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{scripts.filter((r) => r.enabled).length}/{scripts.length}</span>
}

function BulkMenu({ label, scripts, onToggle }: { label: string; scripts: RegexScript[]; onToggle: (enabled: boolean) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={
        <Button variant="ghost" size="icon-sm" className="size-7 shrink-0 text-muted-foreground" aria-label={`Actions for ${label} scripts`}>
          <DotsThreeVertical className="size-4" aria-hidden="true" />
        </Button>
      } />
      <DropdownMenuContent align="end">
        <DropdownMenuItem disabled={scripts.every((r) => r.enabled)} onClick={() => onToggle(true)}>
          <ToggleRight className="size-4" aria-hidden="true" />Turn all on
        </DropdownMenuItem>
        <DropdownMenuItem disabled={scripts.every((r) => !r.enabled)} onClick={() => onToggle(false)}>
          <ToggleLeft className="size-4" aria-hidden="true" />Turn all off
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => { downloadJson(scripts.map(regexExport), `${label.replace(/[^\w-]+/g, "_")}_regex.json`); toast.success(`Exported ${scripts.length} scripts`) }}>
          <DownloadSimple className="size-4" aria-hidden="true" />Export all
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}


function HighlightedInput({ text, matches }: { text: string; matches: { start: number; end: number }[] }) {
  if (matches.length === 0) return <>{text}</>
  const parts: React.ReactNode[] = []
  let last = 0
  matches.forEach((mt, i) => {
    if (mt.start > last) parts.push(<span key={`t${i}`}>{text.slice(last, mt.start)}</span>)
    parts.push(
      <mark key={`m${i}`} className="rounded-sm bg-primary/25 text-foreground">
        {text.slice(mt.start, mt.end)}
      </mark>,
    )
    last = mt.end
  })
  if (last < text.length) parts.push(<span key="tail">{text.slice(last)}</span>)
  return <>{parts}</>
}

function TestSandbox({ script }: { script: RegexScript }) {
  const [input, setInput] = useState("Hello *waves*, this is a \"test\" message.\nShe said: \"Try the pattern here.\"")
  // runs in a Worker: a catastrophic-backtracking pattern must cost a
  // "timed out" badge, not the whole tab (the blank-screen bug)
  const [result, setResult] = useState<SafeRegexResult>({ ok: true, output: input, matches: [] })
  useEffect(() => {
    let alive = true
    void runRegexSafe(script.find, script.flags, script.replace, input, { trims: script.trimStrings, timeoutMs: 400 })
      .then((r) => { if (alive) setResult(r) })
    return () => { alive = false }
  }, [script.find, script.flags, script.replace, script.trimStrings, input])
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
      <div className="flex items-center gap-2">
        <Flask className="size-3.5 text-muted-foreground" aria-hidden />
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Test Sandbox</span>
        {result.error ? (
          <Badge variant="destructive" className="ml-auto text-[10px]">{result.error}</Badge>
        ) : (
          <Badge variant="secondary" className="ml-auto text-[10px]">
            {(result.matches ?? []).length} match{(result.matches ?? []).length === 1 ? "" : "es"}
          </Badge>
        )}
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs">Input</Label>
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            rows={5}
            className="font-mono text-xs"
            placeholder="Paste sample text to test against"
          />
          <div className="min-h-10 whitespace-pre-wrap rounded-md border border-border/60 bg-muted/30 p-2 font-mono text-xs leading-relaxed">
            <HighlightedInput text={input} matches={result.matches ?? []} />
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs">Output</Label>
          <div className="min-h-full flex-1 whitespace-pre-wrap rounded-md border border-border bg-card p-2 font-mono text-xs leading-relaxed">
            {result.output || <span className="text-muted-foreground">Empty output</span>}
          </div>
        </div>
      </div>
    </div>
  )
}

const NO_OVERRIDES: Record<string, boolean> = {}

export function RegexView() {
  const scripts = useApp((s) => s.regexScripts)
  const characters = useApp((s) => s.characters)
  const chats = useApp((s) => s.chats)
  const presets = useApp((s) => s.presets)
  const updateRegex = useApp((s) => s.updateRegex)
  const addRegex = useApp((s) => s.addRegex)
  const deleteRegex = useApp((s) => s.deleteRegex)
  const focusRegexId = useApp((s) => s.focusRegexId)
  const activeChatId = useApp((s) => s.activeChatId)
  const [selectedId, setSelectedId] = useViewMemory<string | null>('regex.selected', scripts[0]?.id ?? null)
  const [detailOpen, setDetailOpen] = useViewMemory('regex.detail', false)
  const [confirm, confirmDialog] = useConfirm()
  const [trimDraft, setTrimDraft] = useState("")
  const importRef = useRef<HTMLInputElement>(null)
  const [pendingImport, setPendingImport] = useState<Omit<RegexScript, 'id' | 'order'>[]>([])
  const [query, setQuery] = useState('')
  const [openState, setOpenState] = useViewMemory<Record<string, boolean>>('regex.open', NO_OVERRIDES)
  const targetName = (script: RegexScript) => script.scope === 'character' ? characters.find((c) => c.id === script.scopeTargetId)?.name
    : script.scope === 'chat' ? chats.find((c) => c.id === script.scopeTargetId)?.title
    : script.scope === 'preset' ? presets.find((p) => p.id === script.scopeTargetId)?.name : null

  // what the open chat runs with: those owners sort first and start expanded
  const activeChat = chats.find((c) => c.id === activeChatId) ?? null
  const activePresetId = activeChat && presets.some((p) => p.id === activeChat.presetId)
    ? activeChat.presetId
    : (presets.find((p) => p.isDefault)?.id ?? null)
  const activeCharacter = characters.find((c) => c.id === activeChat?.characterId) ?? null
  const activeCharacterIds = activeCharacter ? [activeCharacter.id, ...(activeCharacter.members ?? [])] : []
  const activeTarget: Record<RegexScript['scope'], string | null> = {
    global: null,
    preset: activePresetId,
    character: activeCharacter && !activeCharacter.isGroup ? activeCharacter.id : null,
    chat: activeChat?.id ?? null,
  }
  const isActive = (script: RegexScript) => script.scope === 'preset' ? script.scopeTargetId === activePresetId
    : script.scope === 'character' ? activeCharacterIds.includes(script.scopeTargetId ?? '')
    : script.scope === 'chat' && script.scopeTargetId === activeChat?.id

  const needle = query.trim().toLowerCase()
  const sections = SCOPES.map((def) => {
    const all = scripts.filter((r) => r.scope === def.scope).sort((a, b) => a.order - b.order)
    const owners = new Map<string, Owner>()
    for (const script of all) {
      const name = targetName(script)
      if (needle && !`${script.name} ${script.folder ?? ''} ${name ?? ''}`.toLowerCase().includes(needle)) continue
      // a script whose owner is unset or gone never runs: those share one group
      const key = `${def.scope}:${name ? script.scopeTargetId : ''}`
      const owner = owners.get(key) ?? { key, name: name ?? def.unassigned, active: !!name && isActive(script), assigned: !!name, scripts: [] }
      owner.scripts.push(script)
      owners.set(key, owner)
    }
    return {
      ...def,
      all,
      owners: [...owners.values()].sort((a, b) => Number(b.active) - Number(a.active) || Number(b.assigned) - Number(a.assigned) || a.name.localeCompare(b.name)),
    }
  })

  const isOpen = (key: string, fallback: boolean) => !!needle || (openState[key] ?? fallback)
  const toggle = (key: string, fallback: boolean) => setOpenState((s) => ({ ...s, [key]: !(s[key] ?? fallback) }))
  const reveal = (script: Pick<RegexScript, 'scope' | 'scopeTargetId'>) =>
    setOpenState((s) => ({ ...s, [script.scope]: true, [`${script.scope}:${script.scopeTargetId ?? ''}`]: true }))
  const setAll = (list: RegexScript[], enabled: boolean) => {
    for (const script of list) if (script.enabled !== enabled) updateRegex(script.id, { enabled })
  }

  useEffect(() => {
    if (!focusRegexId) return
    const script = scripts.find((r) => r.id === focusRegexId)
    if (script) reveal(script)
    setSelectedId(focusRegexId)
    setDetailOpen(true)
    setQuery('')
    useApp.setState({ focusRegexId: null })
  }, [focusRegexId])

  const selected = scripts.find((r) => r.id === selectedId) ?? null

  const select = (id: string | null) => {
    setSelectedId(id)
    setDetailOpen(id !== null)
  }
  const set = (patch: Partial<RegexScript>) => selected && updateRegex(selected.id, patch)

  const handleImport = async (files: FileList | null) => {
    if (!files) return
    const imported: Omit<RegexScript, 'id' | 'order'>[] = []
    for (const file of Array.from(files)) {
      try {
        const json = JSON.parse(await file.text())
        const arr = Array.isArray(json) ? json : [json]
        let valid = 0
        for (const item of arr) {
          const rx = regexImport(item)
          if (rx) { imported.push(rx); valid++ }
        }
        if (!valid) toast.error(`${file.name}: no valid regex scripts`)
        else if (valid < arr.length) toast.error(`${file.name}: ${arr.length - valid} unsupported scripts`)
      } catch { toast.error(`${file.name}: invalid JSON`) }
    }
    setPendingImport(imported)
  }
  const finishImport = (enabled: boolean) => {
    let firstId: string | null = null
    for (const rx of pendingImport) {
      const id = uid('rx')
      useApp.setState((s) => ({ regexScripts: [...s.regexScripts, { ...rx, enabled: enabled && rx.enabled, id, order: s.regexScripts.length }] }))
      useApp.getState().updateRegex(id, {})
      firstId ??= id
    }
    toast.success(`Imported ${pendingImport.length} scripts`)
    setPendingImport([])
    if (firstId) { setQuery(''); if (pendingImport[0]) reveal(pendingImport[0]); select(firstId) }
  }

  const rows = (list: RegexScript[]) => byFolder(list).map(([folder, items]) => (
    <div key={folder} className="flex flex-col gap-0.5">
      {folder && <span className="truncate px-2 pt-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground" title={folder}>{folder}</span>}
      {items.map((script) => (
        <div key={script.id} className={cn('flex min-h-11 items-center gap-3 rounded-md pl-2 pr-3 md:min-h-9', selectedId === script.id ? 'bg-accent' : 'hover:bg-accent/50')}>
          <button
            type="button"
            onClick={() => select(script.id)}
            className={cn('min-h-11 min-w-0 flex-1 truncate text-left text-sm md:min-h-9', !script.enabled && 'text-muted-foreground')}
            title={script.name}
          >
            {script.name}
          </button>
          <Switch checked={script.enabled} onCheckedChange={(enabled) => updateRegex(script.id, { enabled })} aria-label={`Enable ${script.name}`} />
        </div>
      ))}
    </div>
  ))

  return (
    <>
    <MasterDetail
      resizeKey="regex"
      pageScroll
      masterWidth="w-80"
      detailOpen={detailOpen && !!selected}
      onBack={() => setDetailOpen(false)}
      detailTitle={selected?.name}
      master={
        <div className="flex h-full min-h-0 flex-col">
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Regex Scripts</span>
          <div className="flex items-center gap-0.5">
            <input
              ref={importRef}
              type="file"
              accept=".json"
              multiple
              className="hidden"
              onChange={(e) => { handleImport(e.target.files); e.target.value = "" }}
            />
            <Button
              variant="ghost"
              size="icon"
              className="size-9"
              onClick={() => importRef.current?.click()}
              aria-label="Import regex scripts"
              title="Import regex scripts"
            >
              <UploadSimple className="size-3.5" />
            </Button>
          </div>
        </div>
        <div className="border-b border-border p-2">
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search scripts, folders or owners" aria-label="Search regex scripts" />
        </div>
        <div className="min-h-0 flex-1">
          <div className="flex flex-col">
            {sections.map((section) => {
              if (needle && section.owners.length === 0) return null
              const open = isOpen(section.scope, true)
              const shown = section.owners.flatMap((owner) => owner.scripts)
              return (
                <section key={section.scope} aria-label={`${section.label} scripts`} className="border-b border-border last:border-b-0">
                  <div className="flex items-center gap-1 py-1 pl-1 pr-2">
                    <button type="button" onClick={() => toggle(section.scope, true)} aria-expanded={open} className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left">
                      <CaretRight className={cn('size-3 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} aria-hidden="true" />
                      <span className="flex min-w-0 flex-col">
                        <span className="flex items-baseline gap-2 text-sm font-medium">{section.label}<Tally scripts={section.all} /></span>
                        <span className="truncate text-[11px] text-muted-foreground">{section.hint}</span>
                      </span>
                    </button>
                    {section.scope === 'global' && shown.length > 0 && <BulkMenu label="Global" scripts={shown} onToggle={(enabled) => setAll(shown, enabled)} />}
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="size-7 shrink-0 text-muted-foreground"
                      onClick={() => {
                        const scopeTargetId = activeTarget[section.scope]
                        reveal({ scope: section.scope, scopeTargetId })
                        setQuery('')
                        select(addRegex(section.scope, scopeTargetId))
                      }}
                      aria-label={`Add ${section.label.toLowerCase()} script`}
                      title={`Add ${section.label.toLowerCase()} script`}
                    >
                      <Plus className="size-4" aria-hidden="true" />
                    </Button>
                  </div>
                  {open && (
                    <div className="flex flex-col gap-0.5 px-2 pb-2">
                      {section.owners.map((owner) => {
                        if (section.scope === 'global') return <div key={owner.key} className="flex flex-col gap-0.5">{rows(owner.scripts)}</div>
                        const fallback = owner.active || owner.scripts.some((r) => r.id === selectedId)
                        const ownerOpen = isOpen(owner.key, fallback)
                        return (
                          <div key={owner.key} className="flex flex-col gap-0.5">
                            <div className="flex items-center gap-1">
                              <button type="button" onClick={() => toggle(owner.key, fallback)} aria-expanded={ownerOpen} className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left text-xs md:min-h-9">
                                <CaretRight className={cn('size-3 shrink-0 text-muted-foreground transition-transform', ownerOpen && 'rotate-90')} aria-hidden="true" />
                                <span className={cn('min-w-0 truncate', owner.active ? 'font-medium' : 'text-muted-foreground', !owner.assigned && 'italic')} title={owner.name}>{owner.name}</span>
                                {owner.active && <span className="shrink-0 text-[11px] text-primary">current</span>}
                                <span className="ml-auto flex"><Tally scripts={owner.scripts} /></span>
                              </button>
                              <BulkMenu label={owner.name} scripts={owner.scripts} onToggle={(enabled) => setAll(owner.scripts, enabled)} />
                            </div>
                            {ownerOpen && <div className="ml-3.5 flex flex-col gap-0.5 border-l border-border pl-1.5">{rows(owner.scripts)}</div>}
                          </div>
                        )
                      })}
                      {section.owners.length === 0 && <p className="px-2 pb-1 text-xs text-muted-foreground">None yet</p>}
                    </div>
                  )}
                </section>
              )
            })}
            {needle && sections.every((section) => section.owners.length === 0) && <p className="px-2 py-4 text-center text-xs text-muted-foreground">No matching scripts</p>}
          </div>
        </div>
        </div>
      }
      detail={
        selected ? (
        <div className="min-h-0 flex-1">
          <div className="mx-auto flex max-w-2xl flex-col gap-4 p-4">
            <div className="flex items-center gap-2">
              <Input
                value={selected.name}
                onChange={(e) => set({ name: e.target.value })}
                className="text-sm font-medium"
                aria-label="Script name"
              />
              <Switch checked={selected.enabled} onCheckedChange={(v) => set({ enabled: v })} aria-label="Enabled" />
              <Button
                variant="ghost"
                size="icon"
                className="size-8 text-muted-foreground"
                onClick={() => { downloadJson(regexExport(selected), `${selected.name.replace(/[^\w-]+/g, "_")}.json`); toast.success("Exported regex script") }}
                aria-label="Export script"
                title="Export regex script"
              >
                <DownloadSimple className="size-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="size-8 text-muted-foreground hover:text-destructive"
                onClick={() => void confirm({
                  title: `Delete ${selected.name}?`,
                  description: 'The regex script is removed from disk. Chats stop applying it.',
                }).then((yes) => {
                  if (!yes) return
                  const next = scripts.find((r) => r.id !== selected.id)?.id ?? null
                  deleteRegex(selected.id)
                  setSelectedId(next)
                  setDetailOpen(false)
                })}
                aria-label="Delete script"
              >
                <Trash className="size-4" />
              </Button>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label className="text-xs">Scope</Label>
                <Select
                  value={selected.scope}
                  onValueChange={(v) => set({ scope: v as RegexScript["scope"], scopeTargetId: null })}
                >
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="global">Global</SelectItem>
                    <SelectItem value="character">Character</SelectItem>
                    <SelectItem value="chat">Chat</SelectItem>
                    <SelectItem value="preset">Preset</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {selected.scope === "character" && (
                <div className="flex flex-col gap-1.5">
                  <Label className="text-xs">Character</Label>
                  <Select value={selected.scopeTargetId ?? ""} onValueChange={(v) => set({ scopeTargetId: v })}>
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue placeholder="Pick a character" />
                    </SelectTrigger>
                    <SelectContent>
                      {characters.filter((c) => !c.isGroup).map((c) => (
                        <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              {selected.scope === "chat" && (
                <div className="flex flex-col gap-1.5">
                  <Label className="text-xs">Chat</Label>
                  <Select value={selected.scopeTargetId ?? ""} onValueChange={(v) => set({ scopeTargetId: v })}>
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue placeholder="Pick a chat" />
                    </SelectTrigger>
                    <SelectContent>
                      {chats.map((c) => (
                        <SelectItem key={c.id} value={c.id}>{c.title}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              {selected.scope === "preset" && (
                <div className="flex flex-col gap-1.5">
                  <Label className="text-xs">Preset</Label>
                  <Select value={selected.scopeTargetId ?? ""} onValueChange={(v) => set({ scopeTargetId: v })}>
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue placeholder="Pick a preset" />
                    </SelectTrigger>
                    <SelectContent>
                      {presets.map((p) => (
                        <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>

            <div className="flex flex-col gap-1.5">
              <Label className="text-xs">Folder</Label>
              <Input value={selected.folder ?? ''} onChange={(e) => set({ folder: e.target.value })} placeholder="No folder" aria-label="Script folder" />
            </div>
            <div className="grid grid-cols-[1fr_auto] gap-3">
              <div className="flex flex-col gap-1.5">
                <Label className="text-xs">Find Regex</Label>
                <Input
                  value={selected.find}
                  onChange={(e) => set({ find: e.target.value })}
                  placeholder="pattern"
                  className="font-mono text-xs"
                />
              </div>
              <div className="flex w-20 flex-col gap-1.5">
                <Label className="text-xs">Flags</Label>
                <Input
                  value={selected.flags}
                  onChange={(e) => set({ flags: e.target.value })}
                  placeholder="gi"
                  className="font-mono text-xs"
                />
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs">Replace with</Label>
              <Textarea rows={5}
                value={selected.replace}
                onChange={(e) => set({ replace: e.target.value })}
                placeholder="Replacement text or markup"
                aria-label="Replacement text"
                className="font-mono text-xs"
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label className="text-xs">Trim Out</Label>
              <div className="flex flex-wrap items-center gap-1.5">
                {selected.trimStrings.map((t, i) => (
                  <Badge key={`${t}-${i}`} variant="secondary" className="gap-1 font-mono text-[10px]">
                    {JSON.stringify(t)}
                    <button
                      type="button"
                      onClick={() => set({ trimStrings: selected.trimStrings.filter((_, j) => j !== i) })}
                      aria-label={`Remove trim string ${t}`}
                      className="text-muted-foreground hover:text-foreground"
                    >
                      <X className="size-2.5" />
                    </button>
                  </Badge>
                ))}
                <Input
                  value={trimDraft}
                  onChange={(e) => setTrimDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.nativeEvent.isComposing && e.keyCode !== 229 && trimDraft) {
                      e.preventDefault()
                      set({ trimStrings: [...selected.trimStrings, trimDraft] })
                      setTrimDraft("")
                    }
                  }}
                  placeholder="Add string to erase from matches, Enter to add"
                  className="h-8 w-full max-w-64 font-mono text-xs"
                  aria-label="Add trim string"
                />
              </div>
            </div>

            <TestSandbox script={selected} />

            <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
              <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Applies to</span>
              {PLACEMENTS.map(([key, label]) => (
                <label key={key} className="flex items-center justify-between text-sm">
                  <span>{label}</span>
                  <Switch
                    checked={selected.placements[key]}
                    onCheckedChange={(v) => set({ placements: { ...selected.placements, [key]: v } })}
                  />
                </label>
              ))}
            </div>

            <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
              <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Changes</span>
              <label className="flex items-center justify-between text-sm">
                <span>Only what&apos;s shown</span>
                <Switch checked={selected.markdownOnly} onCheckedChange={(v) => set({ markdownOnly: v })} />
              </label>
              <label className="flex items-center justify-between text-sm">
                <span>Only what the model reads</span>
                <Switch checked={selected.promptOnly} onCheckedChange={(v) => set({ promptOnly: v })} />
              </label>
              <p className="text-xs text-muted-foreground">
                {selected.markdownOnly && selected.promptOnly ? 'Display and prompt change; the saved message stays as written.'
                  : selected.markdownOnly ? 'Only the display changes; the model and the saved message see the original.'
                  : selected.promptOnly ? 'Only the prompt changes; you see the original.'
                  : 'Rewrites the message itself when it is saved. Existing messages are not touched.'}
              </p>
            </div>

            <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
              <label className="flex items-center justify-between text-sm">
                <span>Also run when I edit a message</span>
                <Switch
                  checked={selected.runOnEdit}
                  disabled={selected.markdownOnly || selected.promptOnly}
                  onCheckedChange={(v) => set({ runOnEdit: v })}
                />
              </label>
              <div className="flex flex-col gap-1.5">
                <Label className="text-xs">Macro Substitution</Label>
                <Select value={selected.macroMode} onValueChange={(v) => set({ macroMode: v as RegexScript["macroMode"] })}>
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Don&apos;t substitute</SelectItem>
                    <SelectItem value="raw">Substitute (raw)</SelectItem>
                    <SelectItem value="escaped">Substitute (escaped)</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  {"Whether {{macros}} in the Find pattern are replaced before matching, raw or regex-escaped."}
                </p>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="flex flex-col gap-1.5">
                  <Label className="text-xs">Min Depth</Label>
                  <Input
                    type="number"
                    value={selected.minDepth ?? ""}
                    onChange={(e) => set({ minDepth: e.target.value === "" ? null : Number(e.target.value) })}
                    placeholder="Unlimited"
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label className="text-xs">Max Depth</Label>
                  <Input
                    type="number"
                    value={selected.maxDepth ?? ""}
                    onChange={(e) => set({ maxDepth: e.target.value === "" ? null : Number(e.target.value) })}
                    placeholder="Unlimited"
                  />
                </div>
              </div>
            </div>
          </div>
        </div>
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            Select or create a regex script
          </div>
        )
      }
    />
    <RegexImportChoice open={pendingImport.length > 0} count={pendingImport.length} onCancel={() => setPendingImport([])} onChoose={finishImport} />
    {confirmDialog}
    </>
  )
}
