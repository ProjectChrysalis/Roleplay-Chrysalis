import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'

export function RegexImportChoice({ open, count, preset, busy, onCancel, onChoose }: {
  open: boolean
  count: number
  preset?: boolean
  busy?: boolean
  onCancel: () => void
  onChoose: (enabled: boolean) => void
}) {
  return (
    <Dialog open={open} onOpenChange={(value) => { if (!value && !busy) onCancel() }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{preset ? 'Enable preset regex?' : 'Enable imported regex?'}</DialogTitle>
          <DialogDescription>{count} scripts are included. {preset ? 'They run only while this preset is in use.' : 'They will be added to Global scripts.'} Scripts disabled in the file stay off.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" disabled={busy} onClick={onCancel}>Cancel</Button>
          <Button variant="outline" disabled={busy} onClick={() => onChoose(false)}>Keep off</Button>
          <Button disabled={busy} onClick={() => onChoose(true)}>Enable</Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
