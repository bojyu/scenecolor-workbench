import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { test } from 'node:test'

test('keeps the eleven known priority scenes on their frozen gates', () => {
  const scriptPath = resolve(process.cwd(), 'skills/chair-angle-matcher/scripts/run-priority-regression.mjs')
  const report = JSON.parse(execFileSync(process.execPath, [scriptPath], {
    cwd: process.cwd(),
    encoding: 'utf8',
    windowsHide: true,
  }))
  assert.equal(report.evaluationRole, 'known-case-regression')
  assert.equal(report.generalizationClaim, false)
  assert.equal(report.caseCount, 11)
  assert.equal(report.passed, true)
  assert.deepEqual(report.failures, [])
})
