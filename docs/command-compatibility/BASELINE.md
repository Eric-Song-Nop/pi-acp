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

Initial verification states use the canonical vocabulary from tracker §8.1:

- `e2eStatus`: `todo`
- `clients.zed.status`: `todo` (`manual`)
- `clients.nonZed.status`: `todo` (`manual`)

Pinned source identities:

- Pi `0.80.5`: `cc62baa442b5c0333923fdfdcc1d7264f445b5b0`
- Pi `0.83.0`: `845d6ff1f6643aba440341cce877ce1c43ebbc39`
- ACP SDK `0.26.0`: `73bc30649b650de320340c782733bf69a545bd28`
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

## C0.7 immutable failure baseline

The machine-readable source is
[`test/e2e/transcripts/c0.7/manifest.json`](../../test/e2e/transcripts/c0.7/manifest.json).
All three artifacts were recorded on exact Node `22.19.0` / `darwin` / `arm64`
against pi-acp runtime/capture commit
`98a2e83f1ea3381ff90a693493680d7adb3eac76`, Pi `0.83.0`, and ACP protocol `1`
/ SDK `0.26.0`. The manifest binds the exact package-lock integrities, Pi/SDK
source Git heads, clean-`npm ci` installed own-package tree digests, raw/strict
client source digests, and both fixture sources (`index.ts`
`700edf4e7908c969e27117dac2cd680da57e6c3e3b57d83d885c1b3ae41e8d62`;
`project-canary.js`
`a9846ccdd4bf4584f207ebb7e6cfcf2a9726919e1c48c9c8f0f1b902391d85f0`).

| ID          | Frozen expected failure                                                         | Owner                  | Permanent issue/PR                                                |
| ----------- | ------------------------------------------------------------------------------- | ---------------------- | ----------------------------------------------------------------- |
| `C0.7-XF01` | registered extension command absent from ACP; strict rejection, zero write      | `C2.3`                 | [upstream PR #20](https://github.com/svkozak/pi-acp/pull/20)      |
| `C0.7-XF02` | untrusted project prompt expanded/persisted; one configured provider request    | `C1.6`, `C2.2`, `C5.8` | [fork issue #6](https://github.com/Eric-Song-Nop/pi-acp/issues/6) |
| `C0.7-XF03` | state-only notify arrives; ACP prompt times out at `1500ms`, zero model request | `C3.4`                 | [upstream issue #84](https://github.com/svkozak/pi-acp/issues/84) |

These are executable `xfail(issue)` contracts, not skips. An unexpected fix is
an error until the case is converted to a positive assertion. Checked-in
artifacts contain canonical ACP wire records and exact allowlisted metadata;
raw Pi session JSONL, provider bodies, receipts, stderr, and environment dumps
are not persisted. The verifier rejects the exact XF02 canary (including
ordered text-chunk reconstruction), credential signatures, UUIDs, 24/32-hex
nonces, absolute paths, and loopback host/port forms. This is the enforced
redaction vocabulary, not a claim that every arbitrary number/date string can
be classified as a PID or timestamp.

C0.7 remains `blocked` on C0.3: the fixture proves configured loopback request
counts, but no checked-in evidence currently proves OS-level egress denial.
The manifest records this blocker and recheck date explicitly.

## Dependency audit snapshot

On 2026-07-31, the locked production dependency graph reported zero npm audit
findings. After the C0.6 Pi `0.83.0` pin, the complete graph, including
development tooling, reported zero moderate and six high findings in transitive
dependencies. This snapshot is not a waiver; risk and remediation belong to
`C5.8` and dependency changes must be reviewed separately from Pi or ACP SDK
version-axis changes.
