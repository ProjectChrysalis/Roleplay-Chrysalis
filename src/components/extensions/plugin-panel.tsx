
import { useState } from 'react'
import { Plus, Trash, CaretRight } from '@phosphor-icons/react'
import { toast } from 'sonner'
import { j } from '@/lib/engine'
import { useApp } from '@/lib/store'
import type { ModelInfo } from '@/lib/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'

/** A plugin ships its own UI as a declarative panel (uiPanel hook →
 *  /__panels): the shape below is the whole contract. The plugin owns the
 *  labels, rows, fields and action URLs; this renderer just draws them. */

export interface PanelField {
  key: string
  label: string
  kind: 'text' | 'number' | 'textarea' | 'code' | 'toggle' | 'select' | 'model' | 'section'
  value: string | number
  /** select only: the choices offered, by stored value */
  options?: { value: string; label: string }[]
  /** one short line under the control */
  hint?: string
}

export interface PanelItem {
  id: string
  title: string
  subtitle?: string
  badge?: string
  enabled: boolean
  saveUrl: string
  deleteUrl?: string
  deleteLabel?: string
  fields?: PanelField[]
  /** small muted footnote under the fields (constraints the plugin wants stated) */
  note?: string
}

export interface PluginPanelDescriptor {
  label: string
  icon?: string
  hint?: string
  items: PanelItem[]
  create?: { url: string; label: string }
}

/** Panel action URLs arrive from PLUGIN code: confine them to plain relative
 *  app paths — no traversal, no protocol-relative tricks, no query strings.
 *  A malicious app must not steer a panel button at engine-level routes. */
function safePanelUrl(u: string): string | null {
  return /^\/[a-zA-Z0-9/_-]*$/.test(u) ? u : null
}

/** toggle fields carry "on"/"off" so the whole values map stays strings */
function toggleValue(raw: string | undefined): boolean {
  return raw === 'on' || raw === 'true' || raw === '1'
}

/** Real model picker for "model" fields: the engine catalog, grouped by
 *  connection, plus the empty choice (the chat's own model). */
function PanelModelSelect({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  const models = useApp((s) => s.models)
  const groups = new Map<string, ModelInfo[]>()
  for (const m of models) {
    const list = groups.get(m.provider)
    if (list) list.push(m)
    else groups.set(m.provider, [m])
  }
  const known = models.some((m) => m.ref === value)
  return (
    <Select
      value={value || 'chat'}
      onValueChange={(v) => onChange(v === 'chat' ? '' : String(v ?? ''))}
    >
      <SelectTrigger className="w-full" aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="chat">The chat's model</SelectItem>
        {/* a saved ref whose connection is gone still shows, never silently
            falls back to the chat model */}
        {value && !known && <SelectItem value={value}>{value}</SelectItem>}
        {[...groups.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([provider, list]) => (
            <SelectGroup key={provider}>
              <SelectLabel>{provider}</SelectLabel>
              {list
                .slice()
                .sort((a, b) => a.id.localeCompare(b.id))
                .map((m) => (
                  <SelectItem key={m.ref} value={m.ref}>{m.id}</SelectItem>
                ))}
            </SelectGroup>
          ))}
      </SelectContent>
    </Select>
  )
}

function FieldRow({ field, value, onChange }: { field: PanelField; value: string; onChange: (v: string) => void }) {
  const label = (
    <span className="flex min-w-0 flex-col gap-0.5">
      <span className="text-sm">{field.label}</span>
      {field.hint && <span className="text-xs text-muted-foreground">{field.hint}</span>}
    </span>
  )

  if (field.kind === 'toggle') {
    return (
      <label className="flex items-center justify-between gap-4">
        {label}
        <Switch checked={toggleValue(value)} onCheckedChange={(v) => onChange(v ? 'on' : 'off')} aria-label={field.label} />
      </label>
    )
  }

  if (field.kind === 'select') {
    return (
      <div className="flex items-center justify-between gap-4">
        {label}
        <Select value={value} onValueChange={(v) => onChange(String(v ?? ''))}>
          <SelectTrigger className="w-48" aria-label={field.label}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(field.options ?? []).map((o) => (
              <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    )
  }

  if (field.kind === 'model') {
    return (
      <div className="flex flex-col gap-2">
        {label}
        <PanelModelSelect value={value} onChange={onChange} label={field.label} />
      </div>
    )
  }

  if (field.kind === 'number' || field.kind === 'text') {
    return (
      <div className="flex flex-col gap-2">
        {label}
        <Input
          value={value}
          inputMode={field.kind === 'number' ? 'numeric' : undefined}
          onChange={(e) => onChange(e.target.value)}
        />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      {label}
      <Textarea
        value={value}
        rows={field.kind === 'code' ? 5 : 3}
        className={cn('text-xs', field.kind === 'code' && 'font-mono')}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  )
}

/** The editor groups fields at their section markers; a field list with no
 *  markers still renders, one group under the item itself. */
function fieldGroups(fields: PanelField[]): { key: string; label?: string; fields: PanelField[] }[] {
  const groups: { key: string; label?: string; fields: PanelField[] }[] = []
  let current: { key: string; label?: string; fields: PanelField[] } = { key: '__default', fields: [] }
  for (const field of fields) {
    if (field.kind === 'section') {
      if (current.fields.length || current.label) groups.push(current)
      current = { key: field.key, label: field.label, fields: [] }
      continue
    }
    current.fields.push(field)
  }
  if (current.fields.length || current.label) groups.push(current)
  return groups
}

function ItemEditor({ item, onSaved, onDeleted }: { item: PanelItem; onSaved: () => void; onDeleted: () => void }) {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries((item.fields ?? []).filter((f) => f.kind !== 'section').map((f) => [f.key, String(f.value)])),
  )
  const [busy, setBusy] = useState(false)

  const save = async () => {
    const url = safePanelUrl(item.saveUrl)
    if (!url) return toast.error('Blocked an unsafe panel action')
    setBusy(true)
    try {
      await j(url, { method: 'PUT', body: JSON.stringify({ enabled: item.enabled, values }) })
      toast.success('Saved')
      onSaved()
    } catch (e) {
      toast.error('Save failed', { description: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    const url = item.deleteUrl ? safePanelUrl(item.deleteUrl) : null
    if (item.deleteUrl && !url) return toast.error('Blocked an unsafe panel action')
    try {
      if (url) await j(url, { method: 'DELETE' })
      toast.success(item.deleteLabel || 'Deleted')
      onDeleted()
    } catch (e) {
      toast.error('Delete failed', { description: (e as Error).message })
    }
  }

  return (
    <div className="border-t border-border p-4">
      <div className="flex flex-col gap-5">
        {fieldGroups(item.fields ?? []).map((group) => (
          <div key={group.key} className="flex flex-col gap-1.5">
            {group.label && (
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{group.label}</h3>
            )}
            <div className="flex flex-col gap-3 rounded-lg border border-border p-3">
              {group.fields.map((field) => (
                <FieldRow
                  key={field.key}
                  field={field}
                  value={values[field.key] ?? ''}
                  onChange={(v) => setValues((s) => ({ ...s, [field.key]: v }))}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
      {item.note && <p className="mt-3 text-xs text-muted-foreground/80">{item.note}</p>}
      <div className="mt-4 flex gap-2">
        <Button size="sm" onClick={save} disabled={busy}>Save</Button>
        {item.deleteUrl && (
          <Button size="sm" variant="ghost" onClick={remove}>
            <Trash className="size-3.5" aria-hidden="true" />
            {item.deleteLabel || 'Delete'}
          </Button>
        )}
      </div>
    </div>
  )
}

export function PluginPanelView({ panel, reload }: { panel: PluginPanelDescriptor; reload: () => void }) {
  const [openId, setOpenId] = useState<string | null>(null)
  const [draft, setDraft] = useState<PanelItem | null>(null)

  const toggle = async (item: PanelItem, enabled: boolean) => {
    const url = safePanelUrl(item.saveUrl)
    if (!url) return toast.error('Blocked an unsafe panel action')
    try {
      await j(url, { method: 'PUT', body: JSON.stringify({ enabled }) })
      reload()
    } catch (e) {
      toast.error('Could not save', { description: (e as Error).message })
    }
  }

  const create = async () => {
    if (!panel.create) return
    const url = safePanelUrl(panel.create.url)
    if (!url) return toast.error('Blocked an unsafe panel action')
    try {
      const r = await j<PanelItem>(url, { method: 'POST', body: JSON.stringify({}) })
      setDraft(r)
      setOpenId(r.id)
    } catch (e) {
      toast.error('Could not start a new item', { description: (e as Error).message })
    }
  }

  const items = draft ? [...panel.items, draft] : panel.items

  return (
    <div className="mx-auto flex max-w-lg flex-col gap-3">
      {panel.hint && <p className="text-sm text-muted-foreground">{panel.hint}</p>}
      {items.map((item) => {
        const hasEditor = (item.fields ?? []).length > 0
        const open = openId === item.id
        return (
          <div key={item.id} className="overflow-hidden rounded-lg border border-border">
            <div className={cn('flex items-center gap-3 px-4 py-3', open && 'bg-muted/10')}>
              {hasEditor ? (
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  onClick={() => setOpenId(open ? null : item.id)}
                  aria-expanded={open}
                >
                  <CaretRight className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} aria-hidden="true" />
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate text-sm font-medium">{item.title}</span>
                    {item.subtitle && <span className="truncate text-xs text-muted-foreground">{item.subtitle}</span>}
                  </span>
                </button>
              ) : (
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm font-medium">{item.title}</span>
                  {item.subtitle && <span className="truncate text-xs text-muted-foreground">{item.subtitle}</span>}
                </div>
              )}
              {item.badge && <span className="rounded border border-border px-1 text-[9px] uppercase text-muted-foreground">{item.badge}</span>}
              <Switch checked={item.enabled} disabled={item === draft} onCheckedChange={(v) => { if (item !== draft) void toggle(item, v) }} aria-label={`Enable ${item.title}`} />
            </div>
            {open && hasEditor && (
              <ItemEditor
                item={item}
                onSaved={() => { setDraft(null); setOpenId(null); reload() }}
                onDeleted={() => { setDraft(null); setOpenId(null); reload() }}
              />
            )}
          </div>
        )
      })}
      {panel.create && (
        <Button variant="outline" size="sm" className="w-fit" onClick={create}>
          <Plus className="size-3.5" aria-hidden="true" /> {panel.create.label}
        </Button>
      )}
    </div>
  )
}
