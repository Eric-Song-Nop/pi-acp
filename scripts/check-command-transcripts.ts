import { verifyCommittedTranscripts } from '../test/helpers/immutable-transcript.js'

const manifest = await verifyCommittedTranscripts()
process.stdout.write(`verified ${String(manifest.cases.length)} C0.7 immutable transcripts\n`)
