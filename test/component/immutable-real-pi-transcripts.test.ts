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

test('C0.7 committed failure transcripts are canonical, content-addressed, and protected', async () => {
  const manifest = await verifyCommittedTranscripts()
  assert.equal(manifest.status, 'blocked')
  assert.equal(manifest.blockedBy.checkpoint, 'C0.3')
  assert.deepEqual(
    manifest.cases.map(item => item.id),
    CASE_IDS
  )
})

for (const caseId of CASE_IDS) {
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
