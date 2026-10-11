import { useState } from 'react'
import { CaretLeft, CaretRight, CircleNotch } from '@phosphor-icons/react'
import { Markdown } from '@/components/markdown'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useEffect } from 'react'
import { ImageLightboxTrigger } from '@/components/ui/image-lightbox'
import { proxyUrl } from '@/lib/engine'

export type MarketplaceDetail = {
  id: string
  greeting: string
  alternateGreetings: string[]
  personality: string
  traits?: string
  scenario: string
  exampleDialogs: string
  creatorNotes: string
  systemPrompt: string
  postHistoryInstructions: string
  lorebookEntries: number
  lorebook?: { name: string; entries: { name: string; keys: string[]; content: string; enabled: boolean }[] } | null
  importable?: boolean
  importReason?: string | null
  avatar?: string | null
}

function InlineImage({ src, alt }: { src?: string; alt?: string }) {
  const [image, setImage] = useState('')
  useEffect(() => {
    setImage('')
    if (!src) return
    if (!/^https?:\/\//i.test(src)) { setImage(src); return }
    let live = true, objectUrl = ''
    void fetch(proxyUrl(src)).then(response => { if (!response.ok) throw new Error('Image request failed'); return response.blob() }).then(blob => {
      if (live) { objectUrl = URL.createObjectURL(blob); setImage(objectUrl) }
    }).catch(() => undefined)
    return () => { live = false; if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [src])
  return image ? <ImageLightboxTrigger src={image} alt={alt || 'Card artwork'}><img src={image} alt={alt ?? ''} loading="lazy" /></ImageLightboxTrigger> : <span className="text-xs text-muted-foreground">{alt || 'Image unavailable'}</span>
}

function Content({ text }: { text: string }) {
  return <Markdown content={text} className="marketplace-preview-markdown" allowStyles={false} imageComponent={InlineImage} />
}

function Section({ title, text }: { title: string; text?: string }) {
  return text?.trim() ? <section className="marketplace-card-section"><h3>{title}</h3><Content text={text} /></section> : null
}

export function MarketplaceCardContent({ data, loading, error, tagline, description }: {
  data: MarketplaceDetail | null; loading: boolean; error: string | null; tagline: string; description: string
}) {
  const [tab, setTab] = useState('core')
  const [greeting, setGreeting] = useState(0)
  const greetings = data ? [data.greeting, ...data.alternateGreetings].filter(text => text?.trim()) : []
  return <Tabs value={tab} onValueChange={setTab} className="marketplace-card-tabs">
    <div className="marketplace-card-tabbar">
      <TabsList aria-label="Card sections" variant="line">
        <TabsTrigger value="core">Core</TabsTrigger>
        <TabsTrigger value="greetings">First messages{greetings.length > 1 ? ` (${greetings.length})` : ''}</TabsTrigger>
        <TabsTrigger value="dialogue">Dialogue</TabsTrigger>
        <TabsTrigger value="lore">Lorebook{data?.lorebookEntries ? ` (${data.lorebookEntries})` : ''}</TabsTrigger>
        <TabsTrigger value="advanced">Advanced</TabsTrigger>
      </TabsList>
    </div>
    <div className="marketplace-preview-body">
      {loading && <p className="flex items-center gap-2 text-xs text-muted-foreground" role="status"><CircleNotch className="size-4 animate-spin" />Loading the card…</p>}
      {error && <p className="text-xs text-destructive" role="alert">Couldn&apos;t load the full card: {error}</p>}
      <TabsContent value="core">
        <Section title="About" text={tagline} />
        <Section title="Creator notes" text={data?.creatorNotes || description} />
        <Section title="Description" text={data?.personality} />
        <Section title="Personality" text={data?.traits} />
        <Section title="Scenario" text={data?.scenario} />
      </TabsContent>
      <TabsContent value="greetings">
        {greetings.length ? <section className="marketplace-card-section">
          <div className="marketplace-greeting-controls">
            <h3>{greeting === 0 ? 'First message' : `Alternate ${greeting}`}</h3>
            <span className="text-xs tabular-nums text-muted-foreground">{greeting + 1} / {greetings.length}</span>
            <Button variant="outline" size="icon" disabled={greeting === 0} onClick={() => setGreeting(i => i - 1)} aria-label="Previous greeting"><CaretLeft /></Button>
            <Button variant="outline" size="icon" disabled={greeting >= greetings.length - 1} onClick={() => setGreeting(i => i + 1)} aria-label="Next greeting"><CaretRight /></Button>
          </div>
          <div className="marketplace-preview-greeting"><Content text={greetings[greeting] ?? ''} /></div>
        </section> : !loading && <p className="text-sm text-muted-foreground">No public greetings.</p>}
      </TabsContent>
      <TabsContent value="dialogue">
        <Section title="Example dialogue" text={data?.exampleDialogs} />
        {!loading && !data?.exampleDialogs && <p className="text-sm text-muted-foreground">No example dialogue.</p>}
      </TabsContent>
      <TabsContent value="lore">
        {!loading && !data?.lorebookEntries && <p className="text-sm text-muted-foreground">No embedded lorebook.</p>}
        {!!data?.lorebookEntries && <>
          <p className="text-xs text-muted-foreground">{data.lorebook?.name || 'Embedded lorebook'} · {data.lorebookEntries} entries. Choose whether to import it.</p>
          {data.lorebook?.entries.map((entry, index) => <details className="marketplace-preview-section" key={index}>
            <summary>{entry.name || `Entry ${index + 1}`}{!entry.enabled && <span className="ml-2 text-xs font-normal">Disabled</span>}</summary>
            {!!entry.keys.length && <p className="mb-2 text-xs text-muted-foreground">Keys: {entry.keys.join(', ')}</p>}
            <Content text={entry.content} />
          </details>)}
          {!data.lorebook?.entries.length ? <p className="text-sm text-muted-foreground">The source does not expose entry previews.</p> : data.lorebook.entries.length < data.lorebookEntries && <p className="text-xs text-muted-foreground">Showing {data.lorebook.entries.length} of {data.lorebookEntries} entries.</p>}
        </>}
      </TabsContent>
      <TabsContent value="advanced">
        <Section title="System prompt" text={data?.systemPrompt} />
        <Section title="Post-history instructions" text={data?.postHistoryInstructions} />
        {!loading && !data?.systemPrompt && !data?.postHistoryInstructions && <p className="text-sm text-muted-foreground">No additional instructions.</p>}
      </TabsContent>
    </div>
  </Tabs>
}
