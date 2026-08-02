import assert from 'node:assert/strict'
import test from 'node:test'
import {
  C0_7_TRANSCRIPT_ROOT,
  readVerifiedArtifact,
  readVerifiedManifest,
  verifyCommittedTranscripts
} from '../helpers/immutable-transcript.js'
import { runRealPiBaselineCase, type BaselineCaseId } from '../helpers/real-pi-baseline-scenarios.js'
import {
  assertInstalledPackageTreesMatchManifest,
  assertRuntimeSourcesMatchGitHead,
  readCurrentRepositoryGitHead,
  runtimeSourceTreesMatchGitHeads
} from '../../scripts/update-command-transcripts.js'

const TEST_TIMEOUT_MS = 45_000
const CASE_IDS: readonly BaselineCaseId[] = ['C0.7-XF01', 'C0.7-XF02', 'C0.7-XF03']
const LIVE_REPLAY_CASE_IDS: readonly BaselineCaseId[] = ['C0.7-XF01']
const HISTORICAL_NO_APPROVE_CASE_ID: BaselineCaseId = 'C0.7-XF02'
const HISTORICAL_STATE_ONLY_CASE_ID: BaselineCaseId = 'C0.7-XF03'

test('C0.7 committed failure transcripts are canonical, content-addressed, and protected', async () => {
  const manifest = await verifyCommittedTranscripts()
  assert.equal(manifest.status, 'blocked')
  assert.equal(manifest.blockedBy.checkpoint, 'C0.3')
  assert.deepEqual(
    manifest.cases.map(item => item.id),
    CASE_IDS
  )
})

test('C0.7-XF02 remains immutable historical no-approve evidence under the current forced-approve policy', async () => {
  const { manifest } = await readVerifiedManifest()
  const expected = manifest.cases.find(item => item.id === HISTORICAL_NO_APPROVE_CASE_ID)
  assert.ok(expected)
  assert.equal(expected.expectedFailure.kind, 'untrusted_project_prompt_expanded')
  assert.equal(expected.expectedFailure.projectTrusted, false)
  assert.equal(expected.expectedFailure.catalogHasCommand, false)
  assert.equal(expected.expectedFailure.configuredLoopbackRequests, 1)
  await readVerifiedArtifact(C0_7_TRANSCRIPT_ROOT, expected)
})

test('C0.7-XF03 remains immutable historical timeout evidence after C3.4 positive completion supersedes live replay', async () => {
  const { manifest } = await readVerifiedManifest()
  const expected = manifest.cases.find(item => item.id === HISTORICAL_STATE_ONLY_CASE_ID)
  assert.ok(expected)
  assert.equal(expected.expectedFailure.kind, 'operation_timeout')
  assert.equal(expected.expectedFailure.operation, 'session/prompt')
  assert.equal(expected.expectedFailure.timeoutMs, 1500)
  assert.equal(expected.expectedFailure.remainedPendingThroughDeadline, true)
  assert.equal(expected.expectedFailure.outboundPromptCount, 1)
  assert.equal(expected.expectedFailure.acpResponseCount, 0)
  assert.equal(expected.expectedFailure.configuredLoopbackRequests, 0)
  assert.deepEqual(expected.expectedFailure.notification, {
    afterPrompt: true,
    contentType: 'text',
    level: 'info',
    sessionUpdate: 'agent_message_chunk',
    text: 'Pi ACP fixture loaded'
  })
  assert.deepEqual(expected.expectedFailure.processExit, { code: 0, signal: null })
  await readVerifiedArtifact(C0_7_TRANSCRIPT_ROOT, expected)
})

for (const caseId of LIVE_REPLAY_CASE_IDS) {
  test(
    `C0.7 [xfail(issue)] ${caseId} matches its real-Pi failure signature`,
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const { manifest } = await readVerifiedManifest()
      const currentGitHead = await readCurrentRepositoryGitHead()
      await assertRuntimeSourcesMatchGitHead(currentGitHead)
      const runtimeSourcesMatchFrozenBaseline = await runtimeSourceTreesMatchGitHeads(
        currentGitHead,
        manifest.compatibility.adapter.baselineGitHead
      )
      await assertInstalledPackageTreesMatchManifest(manifest)
      const expected = manifest.cases.find(item => item.id === caseId)
      assert.ok(expected)
      const committed = await readVerifiedArtifact(C0_7_TRANSCRIPT_ROOT, expected)

      const replayGitHead = runtimeSourcesMatchFrozenBaseline
        ? manifest.compatibility.adapter.baselineGitHead
        : currentGitHead
      const observed = await runRealPiBaselineCase(caseId, {
        baselineGitHead: replayGitHead
      })
      assert.deepEqual(observed.expectedFailure, expected.expectedFailure)
      assert.deepEqual(observed.networkBoundary, expected.networkBoundary)
      assert.equal(observed.clientBehavior, expected.clientBehavior)

      const isRecordingRuntime =
        observed.runtime.nodeVersion === expected.runtime.nodeVersion &&
        observed.runtime.platform === expected.runtime.platform &&
        observed.runtime.arch === expected.runtime.arch
      if (runtimeSourcesMatchFrozenBaseline && isRecordingRuntime) {
        assert.equal(observed.canonicalTranscript.sha256, expected.artifact.sha256)
        assert.equal(observed.canonicalTranscript.recordCount, expected.artifact.recordCount)
        assert.deepEqual(observed.canonicalTranscript.bytes, committed.bytes)
      } else {
        assert.notEqual(
          observed.runtime.nodeVersion,
          '',
          'non-byte-comparable live replays still execute the expected-failure contract'
        )
      }
    }
  )
}
