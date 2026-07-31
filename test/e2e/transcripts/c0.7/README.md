# C0.7 immutable failure transcripts

This directory stores content-addressed ACP wire evidence for the three current
expected failures frozen by checkpoint C0.7.

- Normal tests do not rewrite evidence. They verify `manifest.json`, every
  content-addressed file in `artifacts/`, canonical NDJSON, metadata/manifest
  cross-bindings, and the live real-Pi failure signature. Publisher output is
  `0444`; fresh Git checkout mode `0644` is accepted, while group/world writes,
  symlinks, and unapproved hard links are rejected.
- Artifacts contain the ordered ACP records and exact allowlisted metadata only;
  raw receipts, stderr, Pi session JSONL, provider bodies, and environment dumps
  are not persisted. Canonicalization substitutes the exact fixture root and
  session ID only in `cwd`/`sessionId` fields, and rejects credential
  signatures, UUIDs, 24/32-hex nonces, absolute paths, loopback host/port forms,
  and the XF02 canary—including values reconstructed across ordered ACP text
  chunks. It does not claim to classify every arbitrary number as a PID or every
  date-like string as a timestamp.
- Runtime-specific fields remain exact. A different Node runtime replays the
  expected-failure assertion but does not overwrite or pretend to have recorded
  the checked-in bytes.
- Refreshes require the explicit updater, two byte-identical fresh captures,
  exact Node `22.19.0`, a completely clean Git checkout, the old manifest
  digest, and `--accept-baseline-change`. The checked-in package/lock tuple and
  clean-`npm ci` Pi/ACP own-package tree digests are verified before and after
  capture. An unexpected fix fails; convert that case to a positive assertion
  instead of refreshing it.
- Publication is limited to Linux or Darwin on one local filesystem, host, and
  PID namespace. It uses a cooperative no-follow lock, no-clobber
  content-addressed links, stale-crash recovery, manifest compare-and-swap,
  atomic rename, and directory `fsync`; readers retry a live writer and validate
  a stale recoverable view. These guarantees do not cover NFS/shared-host
  publication or a hostile process with the same UID.

The listener records each HTTP-handler-accepted request once before body
completion and terminalizes that record exactly once as `end`, `timeout`,
`aborted`, or `error`. Completed and partial-request controls prevent an
accepted incomplete request from disappearing behind a false zero count; only
a completed `end` body may contribute XF02 derived evidence. Outcomes and
bodies remain test-internal and are not added to the persisted artifact surface.

The manifest remains `blocked` pending independent verification of C0.3's exact
pushed network-denied CI evidence. These artifacts prove configured loopback
request counts, not OS-level egress denial, and external run-scoped evidence
does not rewrite that boundary retroactively.
