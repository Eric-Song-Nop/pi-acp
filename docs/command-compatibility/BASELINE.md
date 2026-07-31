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
the relevant G5 matrix case is verified. The machine-readable matrix therefore
starts with `e2eStatus: proposed`, using the tracker workflow vocabulary.

Pinned source identities:

- Pi `0.80.5`: `cc62baa442b5c0333923fdfdcc1d7264f445b5b0`
- Pi `0.83.0`: `845d6ff1f6643aba440341cce877ce1c43ebbc39`
- ACP SDK `0.26.0`: `73bc30649b650de320340c782733bf69a545bd28`
- Zed `v1.9.0`: `ced90fc636c4ede05402befc38a63bae7fd741bd`

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

## Dependency audit snapshot

On 2026-07-31, the locked production dependency graph reported zero npm audit
findings. The complete graph, including development tooling, reported one
moderate and six high findings in transitive dependencies. This snapshot is not
a waiver; risk and remediation belong to `C5.8` and dependency changes must be
reviewed separately from Pi or ACP SDK version-axis changes.
