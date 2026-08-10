#!/usr/bin/env bash
set -euo pipefail

gate="${1:-}"
umask 077

readonly PATCHED_PI_SOURCE_SHA='ec55c97d680f8f38359f7b6717c72b83c5e4d29a'
readonly PATCHED_PI_PACKAGE_ROOT="/workspace/node_modules/.pi-acp-patched-pi/${PATCHED_PI_SOURCE_SHA}/package"
readonly PATCHED_PI_STRESS_ITERATIONS=100
readonly PATCHED_PI_STRESS_PATTERN='^C3\.4 (patched Pi completes exact state-only /fixture-state with notify-before-response and no model turn|post-write cancel stops the exact patched child and fresh recovery never replays the command)$'
readonly PATCHED_PI_AGENT_STRESS_ITERATIONS=100
readonly PATCHED_PI_AGENT_SCHEDULE_ITERATIONS=50

require_unset() {
  local name=$1
  if /usr/bin/printenv "$name" >/dev/null 2>&1; then
    echo "${gate} must not receive ${name}" >&2
    exit 1
  fi
}

if [[ "$gate" == 'patched-command-preview' || "$gate" == 'patched-agent-preview' ]]; then
  if [[ "${PI_ACP_PATCHED_PI_PACKAGE_ROOT+x}" != x ]]; then
    echo "${gate} requires PI_ACP_PATCHED_PI_PACKAGE_ROOT" >&2
    exit 1
  fi
  if [[ "$PI_ACP_PATCHED_PI_PACKAGE_ROOT" != "$PATCHED_PI_PACKAGE_ROOT" ]]; then
    echo "${gate} requires the exact pinned patched Pi package root" >&2
    exit 1
  fi
  if [[ "$gate" == 'patched-command-preview' ]]; then
    if [[ "${PI_ACP_EXPERIMENTAL_FIXTURE_STATE+x}" != x || "$PI_ACP_EXPERIMENTAL_FIXTURE_STATE" != 1 ]]; then
      echo 'patched-command-preview requires PI_ACP_EXPERIMENTAL_FIXTURE_STATE=1' >&2
      exit 1
    fi
    require_unset PI_ACP_EXPERIMENTAL_FIXTURE_AGENT
  else
    if [[ "${PI_ACP_EXPERIMENTAL_FIXTURE_AGENT+x}" != x || "$PI_ACP_EXPERIMENTAL_FIXTURE_AGENT" != 1 ]]; then
      echo 'patched-agent-preview requires PI_ACP_EXPERIMENTAL_FIXTURE_AGENT=1' >&2
      exit 1
    fi
    require_unset PI_ACP_EXPERIMENTAL_FIXTURE_STATE
  fi
  if [[ ! -d "$PATCHED_PI_PACKAGE_ROOT" || ! -x "$PATCHED_PI_PACKAGE_ROOT/dist/cli.js" ]]; then
    echo "${gate} requires the verified patched Pi package and executable CLI" >&2
    exit 1
  fi
  if [[ ! -L "$PATCHED_PI_PACKAGE_ROOT/node_modules" ]]; then
    echo "${gate} requires the verified patched Pi dependency link" >&2
    exit 1
  fi
  if [[ "$(readlink -- "$PATCHED_PI_PACKAGE_ROOT/node_modules")" != '../../../@earendil-works/pi-coding-agent/node_modules' ]]; then
    echo "${gate} rejected an unexpected patched Pi dependency link" >&2
    exit 1
  fi
  if [[ "$(cd -- "$PATCHED_PI_PACKAGE_ROOT" && pwd -P)" != "$PATCHED_PI_PACKAGE_ROOT" ]]; then
    echo "${gate} rejected a non-canonical patched Pi package root" >&2
    exit 1
  fi
  if [[ "$(cd -- "$PATCHED_PI_PACKAGE_ROOT/node_modules" && pwd -P)" != '/workspace/node_modules/@earendil-works/pi-coding-agent/node_modules' ]]; then
    echo "${gate} rejected a patched Pi dependency link outside the stock package" >&2
    exit 1
  fi
else
  require_unset PI_ACP_PATCHED_PI_PACKAGE_ROOT
  require_unset PI_ACP_EXPERIMENTAL_FIXTURE_STATE
  require_unset PI_ACP_EXPERIMENTAL_FIXTURE_AGENT
fi

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
    node --import tsx --test --test-concurrency=2 test/unit/*.test.ts test/component/*.test.ts
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
      test/component/real-pi-lf-jsonl-reader.test.ts \
      test/component/real-pi-extension-load-diagnostics.test.ts \
      test/component/real-pi-extension-error.test.ts \
      test/component/real-pi-child-recovery.test.ts \
      test/component/real-pi-builtin-rejection.test.ts
    ;;
  immutable-failures)
    node --import tsx scripts/check-command-transcripts.ts
    node --import tsx --test --test-concurrency=1 \
      test/component/immutable-real-pi-transcripts.test.ts
    ;;
  patched-command-preview)
    preview_tap="${TMPDIR}/patched-command-preview.tap"
    node --import tsx --test --test-concurrency=1 --test-reporter=tap \
      test/component/real-pi-fixture-state-preview.test.ts | tee "$preview_tap"
    if grep -Eq '# (SKIP|skipped [1-9][0-9]*)' "$preview_tap"; then
      echo 'patched-command-preview must run without skipped tests' >&2
      exit 1
    fi
    grep -Eq '^# tests [1-9][0-9]*$' "$preview_tap"
    grep -Fx '# skipped 0' "$preview_tap"

    stress_tap="${TMPDIR}/patched-command-preview-stress.tap"
    for ((stress_iteration = 1; stress_iteration <= PATCHED_PI_STRESS_ITERATIONS; stress_iteration += 1)); do
      if ! node --import tsx --test --test-concurrency=1 --test-reporter=tap \
        --test-name-pattern="$PATCHED_PI_STRESS_PATTERN" \
        test/component/real-pi-fixture-state-preview.test.ts >"$stress_tap" 2>&1; then
        cat "$stress_tap" >&2
        echo "patched-command-preview stress iteration ${stress_iteration} failed" >&2
        exit 1
      fi
      if ! grep -Fx '# tests 2' "$stress_tap" >/dev/null ||
        ! grep -Fx '# pass 2' "$stress_tap" >/dev/null ||
        ! grep -Fx '# fail 0' "$stress_tap" >/dev/null ||
        ! grep -Fx '# skipped 0' "$stress_tap" >/dev/null; then
        cat "$stress_tap" >&2
        echo "patched-command-preview stress iteration ${stress_iteration} did not run exactly the two required schedules" >&2
        exit 1
      fi
      if ((stress_iteration % 10 == 0)); then
        echo "patched-command-preview stress ${stress_iteration}/${PATCHED_PI_STRESS_ITERATIONS} passed"
      fi
    done
    ;;
  patched-agent-preview)
    agent_preview_tap="${TMPDIR}/patched-agent-preview.tap"
    node --import tsx --test --test-concurrency=1 --test-reporter=tap \
      test/component/real-pi-fixture-agent-preview.test.ts | tee "$agent_preview_tap"
    if grep -Eq '# (SKIP|skipped [1-9][0-9]*)' "$agent_preview_tap"; then
      echo 'patched-agent-preview must run without skipped tests' >&2
      exit 1
    fi
    grep -Fx '# tests 2' "$agent_preview_tap"
    grep -Fx '# pass 2' "$agent_preview_tap"
    grep -Fx '# fail 0' "$agent_preview_tap"
    grep -Fx '# skipped 0' "$agent_preview_tap"

    agent_stress_tap="${TMPDIR}/patched-agent-preview-stress.tap"
    for ((stress_iteration = 1; stress_iteration <= PATCHED_PI_AGENT_STRESS_ITERATIONS; stress_iteration += 1)); do
      if ((stress_iteration <= PATCHED_PI_AGENT_SCHEDULE_ITERATIONS)); then
        stress_schedule='preflight'
      else
        stress_schedule='provider-final'
      fi
      if ! PI_ACP_C3_5_STRESS_SCHEDULE="$stress_schedule" \
        node --import tsx --test --test-concurrency=1 --test-reporter=tap \
          test/component/real-pi-fixture-agent-preview.test.ts >"$agent_stress_tap" 2>&1; then
        cat "$agent_stress_tap" >&2
        echo "patched-agent-preview ${stress_schedule} stress iteration ${stress_iteration} failed" >&2
        exit 1
      fi
      if ! grep -Fx '# tests 1' "$agent_stress_tap" >/dev/null ||
        ! grep -Fx '# pass 1' "$agent_stress_tap" >/dev/null ||
        ! grep -Fx '# fail 0' "$agent_stress_tap" >/dev/null ||
        ! grep -Fx '# skipped 0' "$agent_stress_tap" >/dev/null; then
        cat "$agent_stress_tap" >&2
        echo "patched-agent-preview ${stress_schedule} stress iteration ${stress_iteration} did not run exactly one schedule" >&2
        exit 1
      fi
      if ((stress_iteration % 10 == 0)); then
        echo "patched-agent-preview stress ${stress_iteration}/${PATCHED_PI_AGENT_STRESS_ITERATIONS} passed"
      fi
    done
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
