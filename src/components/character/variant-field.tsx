
import { useState } from 'react'
import { Plus, Trash, Copy, Check, PencilSimple } from '@phosphor-icons/react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { estimateTokens, formatTokens, uid } from '@/lib/tokens'
import { cn } from '@/lib/utils'
import type { AltVariant } from '@/lib/types'

/**
 * A character text field that can carry alternates, the way alternate greetings
 * already do. The chip row picks both the text you edit and the text the
 * character sends: the choice lives on the card, so every chat reads the same
 * variant. "Original" is the base field.
 */
export function VariantField({
  label,
  hint,
  value,
  onChange,
  variants,
  onVariantsChange,
  active,
  onActiveChange,
  rows = 3,
}: {
  label: string
  hint?: string
  value: string
  onChange: (v: string) => void
  variants: AltVariant[]
  onVariantsChange: (next: AltVariant[]) => void
  /** -1 addresses the base field; >= 0 indexes into `variants`. */
  active: number
  onActiveChange: (id: string | undefined) => void
  rows?: number
}) {
  const [renaming, setRenaming] = useState<string | null>(null)

  const current = active < 0 ? value : (variants[active]?.content ?? '')
  const setCurrent = (next: string) => {
    if (active < 0) return onChange(next)
    onVariantsChange(variants.map((v, i) => (i === active ? { ...v, content: next } : v)))
  }

  const addVariant = () => {
    const name = `Variant ${variants.length + 1}`
    const variant = { id: uid('var'), label: name, content: current }
    onVariantsChange([...variants, variant])
    onActiveChange(variant.id)
    toast.success(`Added ${name}`)
  }

  const removeVariant = (i: number) => {
    onVariantsChange(variants.filter((_, j) => j !== i))
    if (active === i) onActiveChange(undefined)
  }

  /** Swap a variant into the base slot, so it becomes what unaware code reads. */
  const promote = (i: number) => {
    const v = variants[i]
    if (!v) return
    onChange(v.content)
    onVariantsChange(variants.map((x, j) => (j === i ? { ...x, content: value } : x)))
    onActiveChange(undefined)
    toast.success(`"${v.label}" is now the primary ${label.toLowerCase()}`)
  }

  return (
    <div className="flex flex-col gap-1.5">
      <Label className="flex flex-wrap items-center gap-2 text-xs">
        {label}
        <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] font-normal text-muted-foreground">
          {formatTokens(estimateTokens(current))} tok
        </span>
        {variants.length > 0 && (
          <span className="font-normal text-muted-foreground">
            {variants.length + 1} variants
          </span>
        )}
        {hint && <span className="font-normal text-muted-foreground">{hint}</span>}
      </Label>

      {/* Variant chips — the base value is always the first, unremovable one. */}
      <div className="flex flex-wrap items-center gap-1">
        <VariantChip
          label="Original"
          active={active < 0}
          onSelect={() => onActiveChange(undefined)}
        />
        {variants.map((v, i) => (
          <VariantChip
            key={v.id}
            label={v.label}
            active={active === i}
            onSelect={() => onActiveChange(v.id)}
            onRename={() => setRenaming(v.id)}
            onPromote={() => promote(i)}
            onRemove={() => removeVariant(i)}
          />
        ))}
        <Button
          variant="ghost"
          size="sm"
          className="h-6 gap-1 px-1.5 text-[11px]"
          onClick={addVariant}
          aria-label={`Add ${label.toLowerCase()} variant`}
        >
          <Plus className="size-3" aria-hidden="true" />
          Variant
        </Button>
      </div>

      {renaming && (
        <div className="flex items-center gap-1.5">
          <Input
            autoFocus
            defaultValue={variants.find((v) => v.id === renaming)?.label ?? ''}
            className="h-7 max-w-56 text-xs"
            aria-label="Variant name"
            onKeyDown={(e) => {
              if (e.key === 'Escape') setRenaming(null)
              if (e.key === 'Enter') {
                const next = (e.target as HTMLInputElement).value.trim()
                if (next) {
                  onVariantsChange(variants.map((v) => (v.id === renaming ? { ...v, label: next } : v)))
                }
                setRenaming(null)
              }
            }}
            onBlur={(e) => {
              const next = e.target.value.trim()
              if (next) {
                onVariantsChange(variants.map((v) => (v.id === renaming ? { ...v, label: next } : v)))
              }
              setRenaming(null)
            }}
          />
          <span className="text-[11px] text-muted-foreground">Enter to save</span>
        </div>
      )}

      <Textarea
        value={current}
        rows={rows}
        onChange={(e) => setCurrent(e.target.value)}
        aria-label={active < 0 ? label : `${label}: ${variants[active]?.label}`}
        className="text-sm"
      />
      {active >= 0 && (
        <p className="text-[11px] text-muted-foreground">
          This variant is what the character sends.
        </p>
      )}
    </div>
  )
}

function VariantChip({
  label, active, onSelect, onRename, onPromote, onRemove,
}: {
  label: string
  active: boolean
  onSelect: () => void
  onRename?: () => void
  onPromote?: () => void
  onRemove?: () => void
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-0.5 rounded-full border px-1.5 py-0.5 text-[11px] transition-colors',
        active
          ? 'border-primary/50 bg-primary/15 text-foreground'
          : 'border-border text-muted-foreground hover:text-foreground',
      )}
    >
      <button type="button" onClick={onSelect} className="px-0.5" aria-pressed={active}>
        {active && <Check className="mr-0.5 inline size-3" aria-hidden="true" />}
        {label}
      </button>
      {onRename && (
        <button type="button" onClick={onRename} aria-label={`Rename ${label}`} className="opacity-60 hover:opacity-100">
          <PencilSimple className="size-2.5" aria-hidden="true" />
        </button>
      )}
      {onPromote && (
        <button type="button" onClick={onPromote} aria-label={`Make ${label} the primary value`} className="opacity-60 hover:opacity-100">
          <Copy className="size-2.5" aria-hidden="true" />
        </button>
      )}
      {onRemove && (
        <button type="button" onClick={onRemove} aria-label={`Delete ${label}`} className="opacity-60 hover:opacity-100 hover:text-destructive">
          <Trash className="size-2.5" aria-hidden="true" />
        </button>
      )}
    </span>
  )
}
