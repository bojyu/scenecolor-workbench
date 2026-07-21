import assert from 'node:assert/strict'
import { test } from 'node:test'
import { validateRuntimeSelection } from './codexRuntime.js'

test('validates selectable provider, model, reasoning effort, and Skill identifiers', () => {
  assert.deepEqual(validateRuntimeSelection({
    providerId: 'company_proxy',
    model: 'gpt-5.6-terra',
    reasoningEffort: 'xhigh',
    skillId: 'chair-angle-matcher',
  }), {
    providerId: 'company_proxy',
    model: 'gpt-5.6-terra',
    reasoningEffort: 'xhigh',
    skillId: 'chair-angle-matcher',
  })
})

test('falls back safely when runtime identifiers are malformed', () => {
  assert.deepEqual(validateRuntimeSelection({
    providerId: '--danger',
    model: '--model',
    reasoningEffort: 'impossible',
    skillId: '../outside',
  }), {
    providerId: 'codex',
    model: 'gpt-5.6-sol',
    reasoningEffort: 'medium',
    skillId: 'chair-angle-matcher',
  })
})
