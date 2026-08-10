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

## C3.1–C3.5 experimental patched-Pi previews

The verified C3.4 default-off preview tuple is:

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

The verified C3.5 default-off preview tuple is:

```text
pi-acp 0.0.33 implementation @ bfe2f0d3fde105b20581f5d7b86dd485277cd783
  sole parent / C3.4 documentation publication @ ca2d093b57a4d56f3ac39427987a0e6751b28cad
  C3.4 product ancestor @ 28d7aeedb0d6d3b4ad119a40d0f449d667ce6421
× C3.3 adapter bridge @ df92ac575ba44fa92ffd3a8b6b56efc7a449e152
× patched Pi 0.83.0 @ ec55c97d680f8f38359f7b6717c72b83c5e4d29a
  (upstream base 845d6ff1f6643aba440341cce877ce1c43ebbc39)
× ACP protocol 1 / TypeScript SDK 0.26.0
× Node 22.19.0 / npm 10.9.3 in CI; Node 26.5.0 focused/static locally
× raw ACP client / Linux amd64 / network-none execution boundary
× PI_ACP_EXPERIMENTAL_FIXTURE_AGENT=1
  with PI_ACP_EXPERIMENTAL_FIXTURE_STATE unset
```

The C3.4 tuple certifies only exact state-only `/fixture-state` completion with
disposition `handled`. The C3.5 tuple certifies only exact `/fixture-agent`
completion after its attributed provider stream and agent run settle, with
disposition `agent_run`. Each flag is independent, default-off, and enabled
only by exact value `1`. Broader extension publication, general collision and
reserved-name policy, failure/cancel/child-exit lifecycle, streaming
concurrency, dialog, dynamic-catalog, and manual-client claims remain in later
checkpoints. Neither tuple replaces the stock Pi `0.83.0` C0.2 baseline or
constitutes Zed/non-Zed manual certification.

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

### C3.5 agent-triggering execution evidence

The C3.5 implementation is PR #31 commit
[`bfe2f0d3fde105b20581f5d7b86dd485277cd783`](https://github.com/Eric-Song-Nop/pi-acp/commit/bfe2f0d3fde105b20581f5d7b86dd485277cd783),
with sole parent the C3.4 documentation publication
`ca2d093b57a4d56f3ac39427987a0e6751b28cad`, tree
`eedd4552b24a0f6462b29201e74c3535fb4206f3`, and the exact 12-path scope below.
The fixture-only `/fixture-agent` preview is exposed only by exact
`PI_ACP_EXPERIMENTAL_FIXTURE_AGENT=1`. It preserves Pi's request-bound
`agent_run` response only after the attributed provider stream and agent turn
settle, emits the assistant chunk before one ACP `end_turn`, persists exactly
the synthetic user/assistant turn, remains live on the same Pi PID for the
post-completion probe, and then tears down without a surviving child, listener,
receipt writer, temporary evidence file, or repository mutation. General
extension exposure, lifecycle failures, and streaming concurrency remain
deferred.

Fixture-agent ownership follows the generic slash router's `trimStart()`
boundary: a leading space or newline cannot bypass the enabled preview or the
flag-off exact-extension kill switch into generic prompt/model routing. This is
candidate/fence normalization only. A valid invocation remains raw byte-exact:
exactly one text block whose complete content is `/fixture-agent`; leading or
trailing whitespace, arguments, multiple blocks, and attachments are refused
before prompt or execute, while `/fixture-agentx` remains an unrelated generic
route even with leading whitespace. The only structured execution is exact
extension name `fixture-agent` with empty arguments.

Two predecessor candidates are permanently invalidated. Original
`8f77eb12552ae109e975941a3515654b51e8bb26` was rejected by COMMENT
[review `4894728897`](https://github.com/Eric-Song-Nop/pi-acp/pull/31#pullrequestreview-4894728897)
with `1 P1`: its raw candidate check did not match the generic router's
leading-whitespace normalization. Replacement
`53a8e3e75b896879a5b5d505faba4c1a2dd408c0` fixed that routing defect, but
[run `31368632822`](https://github.com/Eric-Song-Nop/pi-acp/actions/runs/31368632822)
failed patched-agent stress iteration 41 after a final release path became
visible before its contents were complete; an exact local reproduction also
observed a zero-byte final receipt during the analogous publication window.
Neither predecessor is accepted evidence.

The final proof harness closes both partial-publication windows. Release
sentinels are written to a unique same-directory staging file, file-fsynced and
closed, then published by an atomic no-clobber hard link; an existing final is
accepted only when its bytes are exactly `release\n`, and a corrupt final is
preserved and rejected. Receipts remain reader-invisible under a unique
`.json.tmp` name until write, file fsync, and close complete, then use a
same-directory rename and directory fsync. Receipt target uniqueness relies on
the contractual fresh private root and single writer: its `lstat`-then-rename
sequence is reader-atomic but is not adversarial atomic no-replace against a
competing same-UID actor. Tests preseed a corrupt final, exercise concurrent
identical release publishers, parse every receipt, and require no staging-file
residue after quiescent shutdown; staging/close/publication/cleanup failures are
preserved rather than hidden.

Exact source-leaf SHA-256 values:

| Source leaf                                               | SHA-256                                                            |
| --------------------------------------------------------- | ------------------------------------------------------------------ |
| `src/pi-rpc/process.ts`                                   | `92aea5099cb2cdb4e0bf53716911f25dba568883c28006ac0c254a8077b3242c` |
| `src/acp/pi-commands.ts`                                  | `08a8da8e555ee71018ee704a2ffe802a897a7e4c0ff737a9ba1ff6a76d562679` |
| `src/acp/agent.ts`                                        | `8795690598a1d87b4597581c65826e666faf6bbddf637832e7eaafa4e60568e8` |
| `test/unit/pi-rpc-execute-command.test.ts`                | `429ea57ffb37505c940f63fce2e9fdbc3f55d03d36bc16123631644be6971332` |
| `test/unit/pi-command-catalog-preview.test.ts`            | `4953c68a268bc1f4ae0043f4b32cf990c6780abb03e0d5cefb85ee444337980e` |
| `test/component/fixture-state-preview.test.ts`            | `43fa89d2fae72cb38e3ca453747657fd8fe4f93760508e5ee5adcef437d6ca21` |
| `test/fixtures/pi-extension-pack/c3.5-agent-run/index.ts` | `1a2e16bf77538d581f0211dcef886171b85d73f7243dfbb763fcb8e88cf452e8` |
| `test/helpers/real-pi-fixture.ts`                         | `79ba15d5cc2a8f67d70626cedf8f3464db2b05788976e68d5d10b331fb8e5f77` |
| `test/component/real-pi-fixture-agent-preview.test.ts`    | `466b6b272e4401e9173306cb634c39c002e196e2b85f280319e3b11c9d2c54e2` |
| `.github/scripts/run-network-denied-ci.sh`                | `a7dec9806a52f857648768f4b9cfeef7c24ba2e2f627d94c4fc0e9b1f1616c9f` |
| `.github/workflows/ci.yml`                                | `7ef3d043a63e5e9f1c72a51525f0de081b894060fc6873c11887f158ed9f801a` |
| `test/unit/ci-workflow-policy.test.ts`                    | `911308b46ed6634ba3322d4fab3670ad79268bb4c67fe83f2a88e000d3794a1b` |

Exact-head [run `31371715892`](https://github.com/Eric-Song-Nop/pi-acp/actions/runs/31371715892)
passed all ten jobs. Full-test job `93402022300` ran 472 tests: 467 passed, zero
failed, and five were expected dedicated-row skips. Patched-agent job
`93402022420` acquired the unchanged public artifact before entering the
read-only, unprivileged, kernel-network-denied Node `22.19.0` Linux/amd64
boundary; its two real-Pi schedules passed `2/2` with zero skips, followed by
`100/100` fresh processes split into 50 asynchronous-preflight and 50
provider-final schedules. Stable required job `93403883152` passed with tested
and expected head `bfe2f0d3…` and base `ca2d093b…`. Local current/exact
focused-policy tests passed `93/93`; the canonical real schedules raise the
combined proof to `95/95`, and the exact local fresh-process stress also passed
`100/100`. Same-author `COMMENTED`
[review `4895294936`](https://github.com/Eric-Song-Nop/pi-acp/pull/31#pullrequestreview-4895294936)
is bound to exact `bfe2f0d3…`, records CLEAN `0 P1/P2/P3`, and leaves PR #31
draft/open/unmerged; the original P1 thread is resolved. It is not represented
as an `APPROVED` review.

Across the implementation, `package.json` remains blob
`302bbd32a25daec8f7bfdd10fc18476ff9f08acf` / SHA-256
`a51d5433ac8d3afdbe3c0691ef71a73b74ce621ac3c47abad5733672dd917a6b`, and
`package-lock.json` remains blob `0dfce41174db70696f090c01a4dd2b6b8d833223`
/ SHA-256
`342287dd88c848abe09556a2778f2e883728fb347f873c5cde4bed51d7e366c3`. The C0.7
transcript tree remains `8c51d3cbb48cf9e7b1762469f9a199be70ac456a`;
its manifest remains blob `79bc179f67eda2f794b134dfdb673bf41ddc9001` /
SHA-256
`edfbbf2807e84f409e826a853e514debb30bd51a964a711cccd0577dea469ce3`,
and every content-addressed artifact remains byte-identical. Rollback
unsets/removes only
`PI_ACP_EXPERIMENTAL_FIXTURE_AGENT` and reverts the fixture-agent path and its
dedicated gate. It preserves C3.4 `/fixture-state`, the immutable Pi artifact,
stock Pi `0.83.0`, and frozen C0.7 evidence; successful fixture-agent turns are
ordinary persisted Pi messages and require no migration or deletion.

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
