#!/usr/bin/env bash
set -euo pipefail

gate="${1:-}"
umask 077

mkdir -p \
  "${HOME}" \
  "${TMPDIR}" \
  "${XDG_CONFIG_HOME}" \
  "${XDG_CACHE_HOME}" \
  "${XDG_DATA_HOME}" \
  "${XDG_STATE_HOME}"

node .github/scripts/assert-network-boundary.mjs

if [[ "$(npm --version)" != "${CI_EXPECTED_NPM_VERSION}" ]]; then
  echo "C0.3 CI requires npm ${CI_EXPECTED_NPM_VERSION}" >&2
  exit 1
fi

before_status="$(git status --porcelain=v1 --untracked-files=all)"

case "${gate}" in
  typecheck)
    node node_modules/typescript/bin/tsc --noEmit
    ;;
  lint)
    node node_modules/eslint/bin/eslint.js .
    ;;
  test)
    node --import tsx --test test/unit/*.test.ts test/component/*.test.ts
    ;;
  build)
    build_root="${TMPDIR}/pi-acp-build-workspace"
    build_output="${build_root}/dist"
    mkdir -p "${build_root}"
    cp -a package.json tsconfig.json tsup.config.ts src "${build_root}/"
    ln -s /workspace/node_modules "${build_root}/node_modules"
    (
      cd "${build_root}"
      node /workspace/node_modules/tsup/dist/cli-default.js --out-dir "${build_output}"
    )
    test -s "${build_output}/index.js"
    test -s "${build_output}/index.js.map"
    ;;
  load-boundaries)
    node --import tsx --test --test-concurrency=1 \
      test/component/real-pi-fixture-pack.test.ts \
      test/component/c0.7-fixture-boundaries.test.ts \
      test/component/real-pi-agent-turn.test.ts \
      test/component/real-pi-extension-load-diagnostics.test.ts \
      test/component/real-pi-extension-error.test.ts
    ;;
  immutable-failures)
    node --import tsx scripts/check-command-transcripts.ts
    node --import tsx --test --test-concurrency=1 \
      test/component/immutable-real-pi-transcripts.test.ts
    ;;
  *)
    echo "Unknown C0.3 CI gate: ${gate}" >&2
    exit 64
    ;;
esac

after_status="$(git status --porcelain=v1 --untracked-files=all)"
if [[ "${after_status}" != "${before_status}" ]]; then
  echo "C0.3 CI gate changed tracked or untracked repository state" >&2
  git status --short >&2
  exit 1
fi
