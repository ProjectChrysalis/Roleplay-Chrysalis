import type { Lorebook } from './types'

export function exportLorebook(book: Lorebook) {
  const entries = Object.fromEntries(book.entries.map((entry, uid) => [uid, {
    uid, key: entry.keys, keysecondary: entry.secondaryKeys,
    comment: entry.title || entry.memo, content: entry.content,
    constant: entry.status === 'constant', vectorized: entry.status === 'vectorized',
    selective: entry.secondaryKeys.length > 0,
    selectiveLogic: { AND_ANY: 0, NOT_ALL: 1, NOT_ANY: 2, AND_ALL: 3 }[entry.logic],
    order: entry.order, position: { before_char: 0, after_char: 1, before_an: 2, after_an: 3, at_depth: 4, before_em: 5, after_em: 6, before_examples: 5, after_examples: 6 }[entry.position],
    depth: entry.depth, role: { system: 0, user: 1, assistant: 2 }[entry.role],
    disable: !entry.enabled, probability: entry.probability, useProbability: entry.useProbability,
    group: entry.group, groupWeight: entry.groupWeight, groupOverride: entry.groupPrioritize,
    sticky: entry.sticky, cooldown: entry.cooldown, delay: entry.delay,
    excludeRecursion: entry.nonRecursable, preventRecursion: entry.preventFurtherRecursion,
    delayUntilRecursion: entry.delayUntilRecursion, ignoreBudget: entry.ignoreBudget,
    automationId: entry.automationId,
    matchCharacterDescription: entry.matchSources.description,
    matchCharacterPersonality: entry.matchSources.personality,
    matchScenario: entry.matchSources.scenario, matchPersonaDescription: entry.matchSources.persona,
    ...(entry.scanDepthOverride != null ? { scanDepth: entry.scanDepthOverride } : {}),
    ...(entry.caseSensitiveOverride != null ? { caseSensitive: entry.caseSensitiveOverride } : {}),
    ...(entry.wholeWordsOverride != null ? { matchWholeWords: entry.wholeWordsOverride } : {}),
    ...(entry.groupScoringOverride != null ? { useGroupScoring: entry.groupScoringOverride } : {}),
  }]))
  return { name: book.name, entries, _chrysalis: book }
}
