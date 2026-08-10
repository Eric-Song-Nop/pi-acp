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

## C3.1–C3.4 experimental patched-Pi preview

The verified default-off preview tuple is:

```text
pi-acp 0.0.33 promotion head @ e198fa37e1fee793a0af0728a1e570d1d0a69b9f
  product implementation @ 28d7aeedb0d6d3b4ad119a40d0f449d667ce6421
× C3.3 adapter bridge @ df92ac575ba44fa92ffd3a8b6b56efc7a449e152
× patched Pi 0.83.0 @ ec55c97d680f8f38359f7b6717c72b83c5e4d29a
  (upstream base 845d6ff1f6643aba440341cce877ce1c43ebbc39)
× ACP protocol 1 / TypeScript SDK 0.26.0
× Node 22.19.0 / npm 10.9.3 in CI; Node 26.5.0 additionally verified locally
× raw ACP client / Linux amd64 / network-none execution boundary
× PI_ACP_EXPERIMENTAL_FIXTURE_STATE=1
```

This tuple certifies only the exact `/fixture-state` extension-command preview.
The flag is off unless its value is exactly `1`; all broader extension-command,
agent-triggering, dialog, dynamic-catalog, and manual-client claims remain in
their later checkpoints. It does not replace the stock Pi `0.83.0` C0.2
baseline or constitute Zed/non-Zed manual certification.

### Immutable patched-Pi artifact record

- Release/tag:
  [`pi-acp-execute-command-v0.83.0.1`](https://github.com/Eric-Song-Nop/pi-mono/releases/tag/pi-acp-execute-command-v0.83.0.1);
  release ID `363749124`, `isImmutable:true`.
- Annotated tag object:
  `a885d9f1a99a17258812cf9cdca4b64174efad1b`, peeling to patched source
  `ec55c97d680f8f38359f7b6717c72b83c5e4d29a`.
- Exact upstream base:
  `845d6ff1f6643aba440341cce877ce1c43ebbc39`; patched source tree:
  `204651bccc3c4141a8e697dee2e8f02eda6e0089`.
- Sole asset ID `498771039`:
  `pi-coding-agent-v0.83.0-pi-acp-execute-command-ec55c97d680f8f38359f7b6717c72b83c5e4d29a.tgz`,
  exactly `5,014,998` bytes.
- Public-asset SHA-256:
  `8f646580e36a9d2fa2cef4c36f0000f0f7cfcfda310bbe6e7f3bc07d4b22bdf1`.
- SHA-512 hex:
  `03588cc7a07bedff0dd96f3d20b0b89281ddcb78fe507dd24947cdf8e6e5ad53c4e4738c6ad79e3b300cbec32c66414899b8f8ca7ffd3e5726c17ff79a8f612c`.
- SHA-512 SRI:
  `sha512-A1iMx6B77f8N2W89ILC4koHdy3j+UH3SSUfN+OblrVPE5HOMateeOzAMvsMsZkFImbj4yn/9PlcmwX/3mo9hLA==`.
- Build/package toolchain: Node `22.19.0`, npm `10.9.3`; after the
  coding-agent build the canonical command was
  `npm pack --ignore-scripts --json ./packages/coding-agent`.

The existing immutable release notes were completed in place with this full
record. Durable read-back preserved the same release/tag/asset identities and
`gh release verify` continued to accept the GitHub attestation; no replacement
tag or asset was created.

Exact patched source-leaf SHA-256 values:

| Source leaf                                                     | SHA-256                                                            |
| --------------------------------------------------------------- | ------------------------------------------------------------------ |
| `packages/coding-agent/docs/rpc.md`                             | `66077ccb2c3722cd9a03c76990b303051b45a8c7a498cfa63840b57d19d7de93` |
| `packages/coding-agent/src/core/agent-session.ts`               | `caaf20097f4ac48e28d427a0cd87af3c12e387ed5c59337bd1dfcee6bbdce875` |
| `packages/coding-agent/src/index.ts`                            | `fe14614e756d2b91b8ea1ab5ee8a16edbf6f96db060fdd0d0b0c51616dd1c585` |
| `packages/coding-agent/src/modes/index.ts`                      | `31870014d1d74c29312e8248873be45e91784bb6fbcaa617c8865c3c3e34df51` |
| `packages/coding-agent/src/modes/rpc/rpc-client.ts`             | `fc26b96cded2c396f7431e628c5173fcef7fb9608b8a4a5330ef52b4ab357a71` |
| `packages/coding-agent/src/modes/rpc/rpc-mode.ts`               | `51936d1df34e54d118c360fb406107dbfbd7ae7d6c5a3637c3f5945a853e742b` |
| `packages/coding-agent/src/modes/rpc/rpc-types.ts`              | `708f62e0ee79e6ff13b13002b7ac1b1d41e85661ce9d32e887f31b38b7ec0065` |
| `packages/coding-agent/test/rpc-client-execute-command.test.ts` | `907a9a10973eec9d7581b16d469129189b70a576d429204a1338ccbbf040649c` |
| `packages/coding-agent/test/rpc-execute-command.test.ts`        | `5a46f2e9c09d18c3a3a0764dfa32e1b4789f41c5fc04bee377220a8778739fdc` |

### C3.4 execution and retention evidence

The C3.4 product implementation is PR #29 commit
[`28d7aeedb0d6d3b4ad119a40d0f449d667ce6421`](https://github.com/Eric-Song-Nop/pi-acp/commit/28d7aeedb0d6d3b4ad119a40d0f449d667ce6421),
with sole parent the accepted C3.3 bridge, tree
`820eb1d1ee73ab63f1f600719d6e9c8b41372049`, and exact 12-path scope. Its
original exact-head [run `30742869970`](https://github.com/Eric-Song-Nop/pi-acp/actions/runs/30742869970)
passed all nine jobs.

Two non-product descendants preserve that implementation identity. Commit
`bd3a873b13b8d652dff3e15660a1d98d7e01f0a6`, tree
`1b0512e5d991750f06fde456a7277ea72fb32033`, changes only
`test/unit/immutable-transcript.test.ts` to inject the immutable transcript's
historical `2026-07-31` recording date. Commit
`e198fa37e1fee793a0af0728a1e570d1d0a69b9f`, tree
`92d7cd7ffba313f5efeb3da1c94502308d078c66`, changes only
`test/e2e/compatibility-matrix.json` and
`test/unit/compatibility-matrix.test.ts` to refresh the live dependency-audit
policy snapshot. The PR-wide promotion scope is therefore 15 distinct paths:
the frozen 12-path implementation plus one historical-test stabilization and
two audit-policy paths.

Final exact-head [run `31361247166`](https://github.com/Eric-Song-Nop/pi-acp/actions/runs/31361247166)
passed all nine jobs at `e198fa37…`. Its patched-preview job `93370478555`
acquired the public artifact before entering the read-only, unprivileged,
kernel-network-denied Node `22.19.0` Linux/amd64 boundary, passed the dedicated
real-Pi cases `3/3` with zero failures or skips, then passed `100/100` fresh
processes and `200/200` selected normal/cancel-recovery schedules. Same-author
COMMENT [review `4894184272`](https://github.com/Eric-Song-Nop/pi-acp/pull/29#pullrequestreview-4894184272)
is bound to exact `e198fa37…` and records a CLEAN `0 P1/P2/P3` audit; it is not
represented as an `APPROVED` review.

Retain the immutable tag, release, attestation, and asset permanently as
provenance. The active patch/acquisition may be deleted only after an equivalent
tagged upstream release passes the same fixture, dual-runtime, public-package,
and network-denied matrix and pi-acp pins it. Rollback disables/removes
`PI_ACP_EXPERIMENTAL_FIXTURE_STATE`, restores stock Pi `0.83.0`, and requires no
session or transcript migration; it never deletes, rewrites, or substitutes the
provenance artifact.

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

On 2026-08-10, the unchanged locked production dependency graph reported zero
findings at every npm audit severity (`total: 0`). The complete graph, including
development tooling, reported zero info, zero low, one moderate, eight high, and
zero critical findings (`total: 9`). Under npm `10.9.3`, the 21 distinct sorted
GHSA identities were:

```text
GHSA-23c5-xmqv-rm74
GHSA-25h7-pfq9-p65f
GHSA-3jxr-9vmj-r5cp
GHSA-3ppc-4f35-3m26
GHSA-3v7f-55p6-f55p
GHSA-4cwx-7wf7-3272
GHSA-52cp-r559-cp3m
GHSA-5p4m-2wfm-xmqj
GHSA-7p8r-x3mc-p8w7
GHSA-7r86-cg39-jmmj
GHSA-8xcm-r25x-g524
GHSA-c2c7-rcm5-vvqj
GHSA-f886-m6hf-6m8v
GHSA-h67p-54hq-rp68
GHSA-jr45-8vmc-qm54
GHSA-m8rv-5g2x-5cg5
GHSA-mh99-v99m-4gvg
GHSA-mw96-cpmx-2vgc
GHSA-rf6f-7fwh-wjgh
GHSA-rgw5-rvv9-x895
GHSA-v3r7-h72x-cjcm
```

The earlier 2026-07-31 six-high snapshot was superseded by live advisory-data
drift without any package or lockfile change. Commit `e198fa37…` refreshes the
machine-readable matrix and its exact regression test; 21 is an identity count,
not the npm vulnerability total.

C0.3 re-runs both audits as a networked live policy check and hard-fails on count,
advisory, tool-version, or availability drift. The recorded values are neither a
claim of future reproducibility nor a waiver; risk and remediation belong to
`C5.8`, and dependency changes must be reviewed separately from Pi or ACP SDK
version-axis changes.
