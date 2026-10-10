import { useApp } from './store'

let focus: { kind: 'preset' | 'message'; id: string; chatId?: string } | null = null
let previous = ''

export function focusAgentContext(value: typeof focus): void {
  focus = value
  publishAgentContext()
}

export function publishAgentContext(): void {
  const state = useApp.getState()
  const chat = state.chats.find(item => item.id === state.activeChatId)
  if (focus?.kind === 'message' && focus.chatId !== chat?.id) focus = null
  const message = focus?.kind === 'message' ? chat?.messages.find(item => item.id === focus?.id) : undefined
  const preset = state.presets.find(item => item.id === (focus?.kind === 'preset' ? focus.id : chat?.presetId))
  const character = state.characters.find(item => item.id === state.activeCharacterId)
  const selection = {
    label: message ? `Message: ${message.swipes[message.activeSwipe]?.content.slice(0, 80) ?? message.authorName ?? message.id}` : focus?.kind === 'preset' && preset ? `Preset: ${preset.name}` : chat ? `Chat: ${chat.title}` : character ? `Character: ${character.name}` : undefined,
    view: state.drawer ?? state.view,
    chatId: chat?.id,
    characterId: character?.id,
    presetId: preset?.id,
    personaId: chat?.personaId,
    messageId: message?.id,
    swipeIndex: message?.activeSwipe,
  }
  const serialized = JSON.stringify(selection)
  if (serialized === previous) return
  previous = serialized
  ;(window as Window & { ChrysalisApp?: { setAgentContext: (selection: unknown) => void } }).ChrysalisApp?.setAgentContext(selection)
}
