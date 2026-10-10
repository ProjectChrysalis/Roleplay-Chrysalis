import { expect, test } from 'bun:test'

test('selection identifies the focused preset or active message swipe and clears stale chat focus', async () => {
  const script = `
    import assert from 'node:assert/strict';
    globalThis.location = { pathname: '/app/admin/roleplay/', protocol: 'http:', host: 'localhost' };
    globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
    const selections = [];
    globalThis.window = { localStorage, matchMedia: () => ({ matches: false }), ChrysalisApp: { setAgentContext: selection => selections.push(selection) } };
    const { useApp } = await import('./src/lib/store');
    const { focusAgentContext, publishAgentContext } = await import('./src/lib/agent-context');
    const chat = { id: 'chat', title: 'Current chat', presetId: 'preset', personaId: 'persona', messages: [{ id: 'message', activeSwipe: 1, swipes: [{ content: 'first' }, { content: 'second' }] }] };
    useApp.setState({ activeChatId: 'chat', activeCharacterId: 'character', chats: [chat], characters: [{ id: 'character', name: 'Character' }], presets: [{ id: 'preset', name: 'Preset' }] });
    publishAgentContext();
    assert.equal(selections.at(-1).chatId, 'chat');
    assert.equal(selections.at(-1).presetId, 'preset');
    focusAgentContext({ kind: 'message', id: 'message', chatId: 'chat' });
    assert.equal(selections.at(-1).messageId, 'message');
    assert.equal(selections.at(-1).swipeIndex, 1);
    assert.equal(selections.at(-1).label, 'Message: second');
    useApp.setState({ activeChatId: null }); publishAgentContext();
    assert.equal(selections.at(-1).messageId, undefined);
    focusAgentContext({ kind: 'preset', id: 'preset' });
    assert.equal(selections.at(-1).label, 'Preset: Preset');
    assert.equal(selections.at(-1).presetId, 'preset');
  `
  const child = Bun.spawn([process.execPath, '--eval', script], { cwd: `${import.meta.dir}/..`, stdout: 'pipe', stderr: 'pipe' })
  const [exit, error] = await Promise.all([child.exited, new Response(child.stderr).text()])
  expect(error).toBe('')
  expect(exit).toBe(0)
}, 5000)
