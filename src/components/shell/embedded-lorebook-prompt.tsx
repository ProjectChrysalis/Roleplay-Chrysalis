import { useState } from 'react'
import { useApp } from '@/lib/store'
import { j } from '@/lib/engine'
import { createToast } from '@/lib/notifications'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'

const toast = createToast('lorebooks')

export function EmbeddedLorebookPrompt() {
  const characters = useApp((s) => s.characters)
  const character = characters.find((c) => c.studioExtras?.embeddedLorebookPending === true && !c.embeddedLorebookId)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const settle = async (importBook: boolean) => {
    if (!character || busy) return
    setBusy(true)
    setError('')
    try {
      await j('/import/embedded-lorebook', { method: 'POST', body: JSON.stringify({ characterId: character.id, import: importBook }) })
      await useApp.getState().hydrate()
      if (importBook) toast.success('Lorebook imported and linked')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={!!character} onOpenChange={(open) => { if (!open) void settle(false) }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Import embedded lorebook?</DialogTitle>
          <DialogDescription>{character?.name} includes a lorebook. Import it for this character, or keep it in the card for later.</DialogDescription>
        </DialogHeader>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="outline" disabled={busy} onClick={() => void settle(false)}>Later</Button>
          <Button disabled={busy} onClick={() => void settle(true)}>{busy ? 'Saving…' : 'Import'}</Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
