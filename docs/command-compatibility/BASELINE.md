# Command compatibility baseline

This document freezes the version axes used by
[`PACP-CMD-2026-01`](TRACKER.md). The machine-readable source for CI and E2E
tests is [`test/e2e/compatibility-matrix.json`](../../test/e2e/compatibility-matrix.json).

## C0.2 tuple

```text
pi-acp 0.0.33 @ d1cffc047ab37a096ee70ca39cfc1de463db8d12
× Pi 0.80.5 (minimum) / 0.83.0 (baseline)
× ACP protocol 1 / TypeScript SDK 0.26.0
× Node 22.19.0 minimum / 24.18.1 baseline / 26.5.0 recorded
× Zed 1.9.0 build 20260701.153843
× CodeCompanion.nvim 19.21.0 @ cedbead815fb435026daa63a487bb69260c1cf69
```

The Pi package versions were installation/version-probed with an isolated
`PI_PACKAGE_DIR`. Full command and extension compatibility is not claimed until
the relevant G5 matrix case is verified.

Current verification states use the canonical vocabulary from tracker §8.1:

- `e2eStatus`: `verified`
- `clients.zed.status`: `todo` (`manual`)
- `clients.nonZed.status`: `todo` (`manual`)

The verified E2E status covers the C0.3 gate and in-repository harness boundary.
It is not G5 command/client certification; both manual client axes remain
`todo`.

Pinned source identities:

- Pi `0.80.5` (`earendil-works/pi`):
  `cc62baa442b5c0333923fdfdcc1d7264f445b5b0`; npm SRI
  `sha512-GPYFuHw1BN+3m5Gzw1HGH41WdFDzbplLauS0zYSf1ZOkgKFd6wtEAcjchB/vmz9YtTGbQOwECbsVj6GxZxungA==`
- Pi `0.83.0` (`earendil-works/pi`):
  `845d6ff1f6643aba440341cce877ce1c43ebbc39`; npm SRI
  `sha512-uYhF+FsZxogoSX/AxBcUdiY+ZklubwaXyAoEGA2eQwsHcyEAhUYIKh/WLXe/a8+k8eTCmxb+ZN2Zo9mzQtzbWw==`
- ACP SDK `0.26.0` (`agentclientprotocol/typescript-sdk`):
  `73bc30649b650de320340c782733bf69a545bd28`; npm SRI
  `sha512-ialrcI+RzKOYe+fw+TfpyTdRmEoqIkXLlwbTi6XgaXXfdhNcdod7TmE1VsTnG3yTlox8TMTSMQgWbLLbz3r86Q==`
- Zed `v1.9.0`: `ced90fc636c4ede05402befc38a63bae7fd741bd`
- CodeCompanion.nvim `v19.21.0`: `cedbead815fb435026daa63a487bb69260c1cf69`

## Target test window

- Pi `0.80.5` is the minimum matrix version. The previously documented
  `0.80.4` is not available from the npm registry.
- Pi `0.83.0` is the baseline version.
- Pi releases between the minimum and baseline are inside the target window.
  This is not a completed compatibility claim; certification remains gated by
  `G5`. Releases outside that window are best effort until added to the matrix.
- Pi `main` is informational and may fail without blocking a release.
- Pi and the ACP SDK must never be upgraded in the same pull request.
- The ACP SDK dependency and lockfile remain pinned to `0.26.0`; migration to 1.x
  belongs to `C6.4`.
- Node `22.19.0` is the minimum because both pinned Pi endpoints require it.

The E2E harness must remove ambient `PI_PACKAGE_DIR`,
`PI_CODING_AGENT_DIR`, provider credentials, and developer configuration before
launching Pi. It then supplies isolated replacements explicitly.

## Client axes

- Raw permissive and strict-catalog clients will be implemented by the
  in-repository harness under `C0.5`.
- Zed is pinned to version `1.9.0`, build `20260701.153843`, for manual strict
  client behavior. Its source tag resolves to
  `ced90fc636c4ede05402befc38a63bae7fd741bd`.
- The non-Zed manual client is
  `olimorris/codecompanion.nvim@v19.21.0`
  (`cedbead815fb435026daa63a487bb69260c1cf69`).

Exact runtime versions and the compatibility tuple must be included in every
transcript artifact. A newer local installation is not evidence for a pinned
matrix case.

## C0.3 CI execution boundary and live provenance

`C0.3` is `verified`. Pushed CI
[run `30642047986`](https://github.com/Eric-Song-Nop/pi-acp/actions/runs/30642047986)
against exact implementation head
[`1a6a00c1f62bcb165b9738ef308f2f9d73151953`](https://github.com/Eric-Song-Nop/pi-acp/commit/1a6a00c1f62bcb165b9738ef308f2f9d73151953)
passed every distinct blocking gate and the stable `required` aggregate.
Independent review bound its clean disposition, with no P1/P2/Low, to that
exact implementation head and run, then resolved the
[sole PR #9 review thread](https://github.com/Eric-Song-Nop/pi-acp/pull/9#discussion_r3691265707).
The separate documentation-only publication head
[`e4cdeecd64f2652d1bc32f1a26844ec2f8dc4c8b`](https://github.com/Eric-Song-Nop/pi-acp/commit/e4cdeecd64f2652d1bc32f1a26844ec2f8dc4c8b)
also passed all eight jobs in
[run `30642477922`](https://github.com/Eric-Song-Nop/pi-acp/actions/runs/30642477922);
it does not replace the run-scoped implementation identity. C0.7's own
replacement head was already independently clean, so this verification
discharges its only remaining operational blocker.

Exact CI toolchain and policy pins:

- `.node-version`: `22.19.0`; npm: `10.9.3`
- CI image:
  `node:22.19.0-bookworm@sha256:afff6d8c97964a438d2e6a9c96509367e45d8bf93f790ad561a1eaea926303d9`
  (`linux/amd64`)
- Acquisition/provenance network: `networked-preflight`; execution network:
  `docker-none-loopback-only`
- Required gates: `provenance`, `typecheck`, `lint`, `test`, `build`, and
  `real-pi-e2e`

Checkout, Node setup, `npm ci`, image acquisition, registry/GitHub provenance,
and both npm audits run in the explicitly networked preflight. The provenance
step hard-fails when an immutable package name/version/npm `gitHead`/SHA-512 SRI,
repository-independent and credential/proxy-neutralized Git smart-HTTP peeled
repository tag, exact audit severity total, or sorted GHSA identity drifts or
cannot be verified. Network Git runs from a canonical fresh temporary cwd with
ancestor discovery stopped at its parent, an explicit `/dev/null` Git directory,
system/global/environment config isolation, and HTTPS-only transport.
Repository-local and worktree URL-scoped helpers, headers, proxies, and rewrites
cannot participate; empty command-line helper/header/proxy values are additional
defense, not the isolation boundary. The audit is a live mutable-policy check
under npm `10.9.3`, not reproducible immutable evidence and not a vulnerability
waiver. Latest package versions and Pi `main` are warn-only observations.

Each provenance run emits its own `testedCheckoutSha` from `git rev-parse HEAD`
and compares it with `expectedCheckoutSha` from the GitHub event. The historical
`adapter.baselineSha` remains the C0.2 tuple identity; a run-scoped tested SHA is
never copied into the matrix.

Gate execution uses the pinned Linux/amd64 container with `--network none` and
only its loopback interface, zero effective capabilities, no-new-privileges, an
unprivileged UID/GID, a read-only checkout/root, isolated temporary homes, and a
preflight that verifies loopback works while external IPv4/IPv6 connects receive
kernel denial. This proves an execution-only Linux/x64 process-tree boundary. It
does not claim the acquisition/provenance phase is offline, does not certify
macOS or Windows containment, and does not turn environment flags into egress
proof.

The real-Pi execution cases install and run only Pi `0.83.0`. Pi `0.80.5` remains
an immutable provenance pin and target-window endpoint, not a C0.3 executed
compatibility case. The positive agent-turn fixture sends one fixed user message
to one deterministic loopback provider response, asserts one bounded provider
request, the exact ACP text chunk and `end_turn`, and clean process/socket
teardown without a real model account. The load-only case and sole live C0.7
`C0.7-XF01` expected-failure replay run in the same denied execution boundary.
The immutable `C0.7-XF02` and `C0.7-XF03` artifacts are historical-only and do
not execute a current-runtime replay.

## C0.7 immutable failure baseline

The machine-readable source is
[`test/e2e/transcripts/c0.7/manifest.json`](../../test/e2e/transcripts/c0.7/manifest.json).
All three artifacts were recorded on exact Node `22.19.0` / `darwin` / `arm64`
against pi-acp runtime/capture commit
`1009c1e58536c7c907348356706c148cf5593e87`, Pi `0.83.0`, and ACP protocol `1`
/ SDK `0.26.0`. The manifest SHA-256 is
`edfbbf2807e84f409e826a853e514debb30bd51a964a711cccd0577dea469ce3`.
The manifest binds the exact package-lock integrities, Pi/SDK source Git heads,
clean-`npm ci` installed own-package tree digests, raw/strict client source
digests, and both fixture sources (`index.ts`
`700edf4e7908c969e27117dac2cd680da57e6c3e3b57d83d885c1b3ae41e8d62`;
`project-canary.js`
`a9846ccdd4bf4584f207ebb7e6cfcf2a9726919e1c48c9c8f0f1b902391d85f0`).

| ID          | Frozen expected failure                                                         | Owner                  | Permanent issue/PR                                                |
| ----------- | ------------------------------------------------------------------------------- | ---------------------- | ----------------------------------------------------------------- |
| `C0.7-XF01` | registered extension command absent from ACP; strict rejection, zero write      | `C2.3`                 | [upstream PR #20](https://github.com/svkozak/pi-acp/pull/20)      |
| `C0.7-XF02` | untrusted project prompt expanded/persisted; one configured provider request    | `C1.6`, `C2.2`, `C5.8` | [fork issue #6](https://github.com/Eric-Song-Nop/pi-acp/issues/6) |
| `C0.7-XF03` | state-only notify arrives; ACP prompt times out at `1500ms`, zero model request | `C3.4`                 | [upstream issue #84](https://github.com/svkozak/pi-acp/issues/84) |

`C0.7-XF02` remains immutable historical evidence. The original 2026-07-31
`DEC-004` never-implicit-approval decision remains in the tracker as superseded
history. On 2026-08-02, `DEC-008` intentionally selected forced `--approve` for
every ACP project, so the live checkpoint is superseded by a positive trust-all
policy assertion in `C1.6`; the frozen artifact is not recaptured or rewritten.

`C0.7-XF03` likewise remains immutable historical evidence of the original
state-only timeout. C3.4's patched/pinned Pi positive state-only completion
proof supersedes its live expected-failure replay; the frozen manifest and
artifact are not recaptured or rewritten.

The C1.6 client surface is limited to a fixed post-child-start warning in
`session/new` and explicit `session/load` `_meta.piAcp.startupInfo`, including
when `quietStartup=true`. The warning discloses an approval that has already
occurred; it is not consent. Transparent recovery applies `--approve` to the
replacement child without repeating the same logical session's warning. C1.6
does not add runtime inventory or command-source metadata; those remain deferred
to the catalog/source checkpoints and future upstream capability work.

`C0.7-XF01` remains the sole executable `xfail(issue)` contract, not a skip. An
unexpected fix is an error until that case is converted to a positive
assertion. `C0.7-XF02` and `C0.7-XF03` are explicit historical assertions whose
current behavior is covered by positive C1.6 and C3.4 proofs respectively.
Checked-in artifacts contain canonical ACP wire records and exact allowlisted metadata;
raw Pi session JSONL, provider bodies, receipts, stderr, and environment dumps
are not persisted. The verifier rejects the exact XF02 canary (including
ordered text-chunk reconstruction), credential signatures, UUIDs, 24/32-hex
nonces, absolute paths, and loopback host/port forms. This is the enforced
redaction vocabulary, not a claim that every arbitrary number/date string can
be classified as a PID or timestamp.

The loopback observer records each accepted HTTP request synchronously, then
terminalizes that same record exactly once as `end`, `timeout`, `aborted`, or
`error`; only a completed `end` body is eligible for XF02 derived evidence.
Completed-POST and incomplete handler-timeout controls prevent partial accepted
requests from disappearing behind a false zero count. Terminal outcomes and
bodies remain test-internal; persisted artifacts retain only the allowlisted
count and derived shape.

C0.7 replacement head `f95df57d56497753c12beb864903c02e7ceb99d6` is
independently clean with no P1/P2 and no unresolved review threads. C0.7 is now
operationally `verified` because C0.3's exact pushed network-denied
implementation head/run was independently verified. C0.3's run-scoped Linux
execution evidence is external to the immutable C0.7 manifest and does not
retroactively turn configured loopback counts into OS-level egress denial. The
unchanged manifest continues to record the C0.3 blocker and recheck date that
were true at capture time. A nonblocking Low remains because the committed
observer controls deterministically exercise `end` and `timeout`, but not
separate `aborted` and `error` cases.

## Dependency audit snapshot

On 2026-07-31, the locked production dependency graph reported zero findings at
every npm audit severity (`total: 0`). After the C0.6 Pi `0.83.0` pin, the
complete graph, including development tooling, reported zero info/low/moderate,
six high, and zero critical findings (`total: 6`). The compatibility matrix also
pins the exact sorted GHSA identity set observed by npm `10.9.3`.

C0.3 re-runs both audits as a networked live policy check and hard-fails on count,
advisory, tool-version, or availability drift. The recorded values are neither a
claim of future reproducibility nor a waiver; risk and remediation belong to
`C5.8`, and dependency changes must be reviewed separately from Pi or ACP SDK
version-axis changes.
