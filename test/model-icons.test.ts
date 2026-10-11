import { describe, expect, it } from 'bun:test'
import { iconKeyForModel } from '../src/lib/model-icons'

describe('model company icons', () => {
  it('resolves companies behind named router connections', () => {
    for (const [model, icon] of [
      ['c_openrouter/arcee-ai/trinity', 'arcee'],
      ['c_router/stepfun/step-3.5-flash', 'stepfun'],
      ['c_router/xiaomi/mimo-v2', 'xiaomimimo'],
      ['openrouter/anthropic/claude-sonnet-4', 'anthropic'],
      ['c_router/nousresearch/hermes-4', 'nousresearch'],
      ['c_router/allenai/olmo-3', 'ai2'],
      ['c_router/inception/mercury', 'inception'],
      ['c_router/z-ai/glm-4.7', 'zai'],
    ]) expect(iconKeyForModel(model!)).toBe(icon!)
  })

  it('recognizes versioned model names without confusing arbitrary words', () => {
    expect(iconKeyForModel('gemini2.5')).toBe('google')
    expect(iconKeyForModel('c_openai-compatible/unknown')).toBeNull()
    expect(iconKeyForModel('roleplay')).toBeNull()
    expect(iconKeyForModel('gpt-4.1')).toBe('openai')
  })
})
