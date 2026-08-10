import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const workflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8')
const boundaryScript = readFileSync(
  new URL('../../.github/scripts/assert-network-boundary.mjs', import.meta.url),
  'utf8'
)
const gateScript = readFileSync(new URL('../../.github/scripts/run-network-denied-ci.sh', import.meta.url), 'utf8')

const CHECKOUT_ACTION = 'actions/checkout@11d5960a326750d5838078e36cf38b85af677262'
const SETUP_NODE_ACTION = 'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020'
const NODE_VERSION = '22.19.0'
const NPM_VERSION = '10.9.3'
const CONTAINER_IMAGE = 'node:22.19.0-bookworm@sha256:afff6d8c97964a438d2e6a9c96509367e45d8bf93f790ad561a1eaea926303d9'
const PATCHED_PI_SOURCE_SHA = 'ec55c97d680f8f38359f7b6717c72b83c5e4d29a'
const PATCHED_PI_RELEASE_URL =
  'https://github.com/Eric-Song-Nop/pi-mono/releases/download/pi-acp-execute-command-v0.83.0.1/pi-coding-agent-v0.83.0-pi-acp-execute-command-ec55c97d680f8f38359f7b6717c72b83c5e4d29a.tgz'
const PATCHED_PI_SHA512_HEX =
  '03588cc7a07bedff0dd96f3d20b0b89281ddcb78fe507dd24947cdf8e6e5ad53c4e4738c6ad79e3b300cbec32c66414899b8f8ca7ffd3e5726c17ff79a8f612c'
const PATCHED_PI_SHA512_SRI =
  'sha512-A1iMx6B77f8N2W89ILC4koHdy3j+UH3SSUfN+OblrVPE5HOMateeOzAMvsMsZkFImbj4yn/9PlcmwX/3mo9hLA=='
const PATCHED_PI_PACKAGE_ROOT =
  '/workspace/node_modules/.pi-acp-patched-pi/ec55c97d680f8f38359f7b6717c72b83c5e4d29a/package'
const PATCHED_PI_STRESS_ITERATIONS = 100
const PATCHED_PI_AGENT_STRESS_ITERATIONS = 100
const PATCHED_PI_AGENT_SCHEDULE_ITERATIONS = 50
const ACQUISITION_COMMAND =
  'npm ci --ignore-scripts --no-audit --fund=false\n          --registry=https://registry.npmjs.org/ --userconfig=/dev/null'

function count(source: string, value: string): number {
  return source.split(value).length - 1
}

function jobsSource(): string {
  const marker = '\njobs:\n'
  const index = workflow.indexOf(marker)
  assert.notEqual(index, -1, 'CI workflow must define jobs')
  return workflow.slice(index + marker.length)
}

function jobSource(jobId: string): string {
  const source = jobsSource()
  const marker = `  ${jobId}:\n`
  const start = source.indexOf(marker)
  assert.notEqual(start, -1, `CI workflow must define the ${jobId} job`)
  const remainder = source.slice(start + marker.length)
  const nextJob = /^ {2}[a-z][a-z0-9-]*:\n/mu.exec(remainder)
  return nextJob ? remainder.slice(0, nextJob.index) : remainder
}

test('C0.3 CI checks out the immutable event head with an exact toolchain and provenance preflight', () => {
  assert.equal(workflow.includes('pull_request_target'), false)
  assert.equal(workflow.includes('${{ secrets.'), false)
  assert.equal(workflow.includes('GITHUB_TOKEN'), false)
  assert.match(workflow, /^ {2}pull_request:\s*$/mu)
  assert.match(workflow, /^permissions:\n {2}contents: read$/mu)
  assert.ok(
    workflow.includes(
      "EXPECTED_ADAPTER_SHA: ${{ github.event_name == 'pull_request' && github.event.pull_request.head.sha || github.sha }}"
    )
  )
  assert.ok(
    workflow.includes(
      "C0_3_PR_HEAD_SHA: ${{ github.event_name == 'pull_request' && github.event.pull_request.head.sha || '' }}"
    )
  )
  assert.ok(
    workflow.includes(
      "C0_3_PR_BASE_SHA: ${{ github.event_name == 'pull_request' && github.event.pull_request.base.sha || '' }}"
    )
  )
  assert.ok(workflow.includes(`CI_NODE_VERSION: '${NODE_VERSION}'`))
  assert.ok(workflow.includes(`CI_NPM_VERSION: '${NPM_VERSION}'`))
  assert.ok(workflow.includes(`CI_CONTAINER_IMAGE: ${CONTAINER_IMAGE}`))
  assert.ok(workflow.includes(`CI_PATCHED_PI_RELEASE_URL: ${PATCHED_PI_RELEASE_URL}`))
  assert.ok(workflow.includes(`CI_PATCHED_PI_SOURCE_SHA: ${PATCHED_PI_SOURCE_SHA}`))
  assert.ok(workflow.includes(`CI_PATCHED_PI_SHA512_HEX: ${PATCHED_PI_SHA512_HEX}`))
  assert.ok(workflow.includes(`CI_PATCHED_PI_SHA512_SRI: ${PATCHED_PI_SHA512_SRI}`))

  assert.equal(count(workflow, CHECKOUT_ACTION), 6)
  assert.equal(count(workflow, SETUP_NODE_ACTION), 6)
  assert.equal(count(workflow, "node-version: '22.19.0'"), 6)
  assert.equal(count(workflow, 'persist-credentials: false'), 6)
  assert.equal(count(workflow, 'fetch-depth: 0'), 6)
  assert.equal(count(workflow, 'ref: ${{ env.EXPECTED_ADAPTER_SHA }}'), 6)
  assert.equal(count(workflow, ACQUISITION_COMMAND), 6)

  const provenance = jobSource('provenance')
  assert.match(provenance, /scripts\/check-ci-provenance\.ts/u)
  assert.match(provenance, /--expected-adapter-sha "\$\{EXPECTED_ADAPTER_SHA\}"/u)
  assert.equal(provenance.includes('docker run'), false)
})

test('C0.3 CI exposes distinct required gates and a stable aggregate', () => {
  const jobIds = [...jobsSource().matchAll(/^ {2}([a-z][a-z0-9-]*):\n/gmu)].map(match => match[1])
  assert.deepEqual(jobIds, ['provenance', 'typecheck', 'lint', 'test', 'build', 'real-pi-e2e', 'required'])

  for (const jobId of ['typecheck', 'lint', 'test', 'build', 'real-pi-e2e']) {
    assert.match(jobSource(jobId), /^ {4}needs: provenance$/mu)
  }

  const realPi = jobSource('real-pi-e2e')
  assert.match(realPi, /fail-fast: false/u)
  assert.match(realPi, /suite: load-boundaries/u)
  assert.match(realPi, /suite: immutable-failures/u)
  assert.match(realPi, /suite: patched-command-preview/u)
  assert.match(realPi, /suite: patched-agent-preview/u)
  assert.match(realPi, /pi-0\.83\.0-raw-load-boundaries/u)
  assert.match(realPi, /pi-0\.83\.0-raw-strict-xfails/u)
  assert.match(realPi, /pi-0\.83\.0-patched-command-preview/u)
  assert.match(realPi, /pi-0\.83\.0-patched-agent-preview/u)
  assert.equal(count(realPi, 'patched_preview: false'), 2)
  assert.equal(count(realPi, 'patched_preview: true'), 2)
  assert.equal(count(realPi, 'fixture_state_preview: true'), 1)
  assert.equal(count(realPi, 'fixture_agent_preview: true'), 1)
  assert.equal(count(realPi, 'fixture_state_preview: false'), 3)
  assert.equal(count(realPi, 'fixture_agent_preview: false'), 3)

  const required = jobSource('required')
  assert.match(required, /if: \$\{\{ always\(\) \}\}/u)
  for (const gate of ['provenance', 'typecheck', 'lint', 'test', 'build', 'real-pi-e2e']) {
    assert.ok(required.includes(`- ${gate}`), `aggregate must depend on ${gate}`)
    assert.ok(required.includes(`needs.${gate}.result`), `aggregate must require ${gate} success`)
  }
})

test('every executable gate runs unprivileged in the same loopback-only Docker policy', () => {
  const requiredTokens = [
    '--platform linux/amd64',
    '--network none',
    '--cap-drop ALL',
    '--security-opt no-new-privileges=true',
    '--read-only',
    '--pids-limit 512',
    '--tmpfs /tmp:rw,nosuid,nodev,exec,mode=1777',
    '--user "$(id -u):$(id -g)"',
    'target=/workspace,readonly',
    '--workdir /workspace',
    '/usr/bin/env -i',
    'CI_EXPECTED_NODE_VERSION="${CI_NODE_VERSION}"',
    'CI_EXPECTED_NPM_VERSION="${CI_NPM_VERSION}"',
    'GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0 GIT_OPTIONAL_LOCKS=0',
    '/bin/bash /workspace/.github/scripts/run-network-denied-ci.sh'
  ]

  for (const jobId of ['typecheck', 'lint', 'test', 'build', 'real-pi-e2e']) {
    const source = jobSource(jobId)
    assert.ok(source.includes('docker pull "${CI_CONTAINER_IMAGE}"'))
    for (const token of requiredTokens) {
      assert.ok(source.includes(token), `${jobId} must enforce ${token}`)
    }
  }

  assert.ok(jobSource('typecheck').includes('run-network-denied-ci.sh typecheck'))
  assert.ok(jobSource('lint').includes('run-network-denied-ci.sh lint'))
  assert.ok(jobSource('test').includes('run-network-denied-ci.sh test'))
  assert.ok(jobSource('build').includes('run-network-denied-ci.sh build'))
  assert.ok(jobSource('real-pi-e2e').includes('run-network-denied-ci.sh "${{ matrix.suite }}"'))
})

test('C3.4/C3.5 acquire the same exact patched artifact before the network-denied execution boundary', () => {
  const realPi = jobSource('real-pi-e2e')
  const acquisitionStart = realPi.indexOf('Acquire the exact patched Pi artifact over the network')
  const executionStart = realPi.indexOf('docker run --rm --init')

  assert.notEqual(acquisitionStart, -1)
  assert.notEqual(executionStart, -1)
  assert.ok(acquisitionStart < executionStart)
  assert.equal(count(workflow, '.github/scripts/acquire-patched-pi.sh'), 1)
  assert.equal(count(realPi, 'if: ${{ matrix.patched_preview == true }}'), 1)

  const acquisition = realPi.slice(acquisitionStart, executionStart)
  for (const token of [
    '--release-url "${CI_PATCHED_PI_RELEASE_URL}"',
    '--source-sha "${CI_PATCHED_PI_SOURCE_SHA}"',
    '--sha512-hex "${CI_PATCHED_PI_SHA512_HEX}"',
    '--sha512-sri "${CI_PATCHED_PI_SHA512_SRI}"',
    '--stock-package-root "${GITHUB_WORKSPACE}/node_modules/@earendil-works/pi-coding-agent"',
    '--destination-root "${GITHUB_WORKSPACE}/node_modules/.pi-acp-patched-pi"'
  ]) {
    assert.ok(acquisition.includes(token), `patched acquisition must pass ${token}`)
  }
  assert.ok(
    acquisition.includes(
      'expected_package_root="${GITHUB_WORKSPACE}/node_modules/.pi-acp-patched-pi/${CI_PATCHED_PI_SOURCE_SHA}/package"'
    )
  )
  assert.match(acquisition, /before_status="\$\(git status --porcelain=v1 --untracked-files=all\)"/u)
  assert.match(acquisition, /after_status="\$\(git status --porcelain=v1 --untracked-files=all\)"/u)
  assert.match(acquisition, /test "\$\{after_status\}" = "\$\{before_status\}"/u)
  assert.equal(acquisition.includes('--network none'), false)

  const execution = realPi.slice(executionStart)
  assert.equal(execution.includes('acquire-patched-pi.sh'), false)
  assert.equal(execution.includes('CI_PATCHED_PI_RELEASE_URL'), false)
  assert.equal(execution.includes('CI_PATCHED_PI_SHA512_HEX'), false)
  assert.equal(execution.includes('CI_PATCHED_PI_SHA512_SRI'), false)
  assert.equal(gateScript.includes('curl'), false)
  assert.equal(gateScript.includes('acquire-patched-pi.sh'), false)
})

test('C3.4/C3.5 pass mutually exclusive default-off preview flags only to their dedicated matrix rows', () => {
  const genericJobs = ['typecheck', 'lint', 'test', 'build'].map(jobSource).join('\n')
  assert.equal(genericJobs.includes('PI_ACP_PATCHED_PI_PACKAGE_ROOT'), false)
  assert.equal(genericJobs.includes('PI_ACP_EXPERIMENTAL_FIXTURE_STATE'), false)
  assert.equal(genericJobs.includes('PI_ACP_EXPERIMENTAL_FIXTURE_AGENT'), false)

  const realPi = jobSource('real-pi-e2e')
  assert.match(
    realPi,
    /gate_environment=\(\)\n {10}if \[\[ '\$\{\{ matrix\.fixture_state_preview \}\}' == 'true' && '\$\{\{ matrix\.fixture_agent_preview \}\}' == 'false' \]\]; then\n {12}gate_environment=\([\s\S]*?PI_ACP_EXPERIMENTAL_FIXTURE_STATE=1\n {12}\)\n {10}elif \[\[ '\$\{\{ matrix\.fixture_state_preview \}\}' == 'false' && '\$\{\{ matrix\.fixture_agent_preview \}\}' == 'true' \]\]; then\n {12}gate_environment=\([\s\S]*?PI_ACP_EXPERIMENTAL_FIXTURE_AGENT=1\n {12}\)\n {10}fi/u
  )
  assert.equal(count(realPi, 'PI_ACP_PATCHED_PI_PACKAGE_ROOT='), 2)
  assert.equal(count(realPi, 'PI_ACP_EXPERIMENTAL_FIXTURE_STATE=1'), 1)
  assert.equal(count(realPi, 'PI_ACP_EXPERIMENTAL_FIXTURE_AGENT=1'), 1)
  assert.match(realPi, /"\$\{gate_environment\[@\]\}"/u)
  assert.equal(workflow.includes('PI_ACP_PI_COMMAND'), false)

  assert.ok(gateScript.includes(`readonly PATCHED_PI_SOURCE_SHA='${PATCHED_PI_SOURCE_SHA}'`))
  assert.ok(
    gateScript.includes(
      `readonly PATCHED_PI_PACKAGE_ROOT="${PATCHED_PI_PACKAGE_ROOT}"`.replace(
        PATCHED_PI_SOURCE_SHA,
        '${PATCHED_PI_SOURCE_SHA}'
      )
    )
  )
  assert.match(
    gateScript,
    /if \[\[ "\$gate" == 'patched-command-preview' \|\| "\$gate" == 'patched-agent-preview' \]\]; then/u
  )
  assert.match(gateScript, /require_unset PI_ACP_PATCHED_PI_PACKAGE_ROOT/u)
  assert.match(gateScript, /require_unset PI_ACP_EXPERIMENTAL_FIXTURE_STATE/u)
  assert.match(gateScript, /require_unset PI_ACP_EXPERIMENTAL_FIXTURE_AGENT/u)
  assert.match(gateScript, /"\$PI_ACP_EXPERIMENTAL_FIXTURE_STATE" != 1/u)
  assert.match(gateScript, /"\$PI_ACP_EXPERIMENTAL_FIXTURE_AGENT" != 1/u)
  assert.match(gateScript, /\$\{gate\} requires the exact pinned patched Pi package root/u)
  assert.equal(gateScript.includes('PI_ACP_PI_COMMAND'), false)
})

test('the checked-in network and suite scripts make the workflow policy executable', () => {
  assert.match(boundaryScript, /network-denied CI must expose only the loopback interface/u)
  assert.match(boundaryScript, /CapEff/u)
  assert.match(boundaryScript, /NoNewPrivs/u)
  assert.match(boundaryScript, /readlink\('\/proc\/self\/ns\/net'\)/u)
  assert.match(boundaryScript, /assert\.match\(networkNamespace, \/\^net:/u)
  assert.match(boundaryScript, /process\.getuid\(\) > 0/u)
  assert.match(boundaryScript, /process\.getgid\(\) > 0/u)
  assert.match(boundaryScript, /assertReadOnlyWorkspace/u)
  assert.match(boundaryScript, /workspace write failed with unexpected code/u)
  assert.match(boundaryScript, /assertLoopbackRoundTrip/u)
  assert.match(boundaryScript, /assertExternalConnectDenied\('192\.0\.2\.1', 4\)/u)
  assert.match(boundaryScript, /assertExternalConnectDenied\('2001:db8::1', 6\)/u)
  assert.match(boundaryScript, /assertGitHasNoCredentialHooks/u)
  assert.match(boundaryScript, /SENSITIVE_ENVIRONMENT_NAME/u)
  assert.match(boundaryScript, /process\.env\.GIT_CONFIG_NOSYSTEM, '1'/u)
  assert.match(boundaryScript, /process\.env\.GIT_CONFIG_GLOBAL, '\/dev\/null'/u)
  assert.match(boundaryScript, /process\.env\.GIT_TERMINAL_PROMPT, '0'/u)
  assert.match(boundaryScript, /process\.env\.GIT_OPTIONAL_LOCKS, '0'/u)

  for (const gate of [
    'typecheck',
    'lint',
    'test',
    'build',
    'load-boundaries',
    'immutable-failures',
    'patched-command-preview',
    'patched-agent-preview'
  ]) {
    assert.match(gateScript, new RegExp(`^  ${gate}\\)$`, 'mu'))
  }
  assert.match(
    gateScript,
    /test\)[\s\S]*?--test-concurrency=2 test\/unit\/\*\.test\.ts test\/component\/\*\.test\.ts[\s\S]*?;;\n {2}build\)/u
  )
  assert.match(gateScript, /test\/component\/real-pi-agent-turn\.test\.ts/u)
  assert.match(gateScript, /test\/component\/real-pi-extension-load-diagnostics\.test\.ts/u)
  assert.match(gateScript, /test\/component\/real-pi-builtin-rejection\.test\.ts/u)
  assert.match(
    gateScript,
    /load-boundaries\)[\s\S]*?--test-concurrency=1[\s\S]*?test\/component\/real-pi-child-recovery\.test\.ts[\s\S]*?test\/component\/real-pi-builtin-rejection\.test\.ts[\s\S]*?;;\n {2}immutable-failures\)/u
  )
  assert.match(gateScript, /scripts\/check-command-transcripts\.ts/u)
  assert.match(
    gateScript,
    /patched-command-preview\)[\s\S]*?--test-concurrency=1 --test-reporter=tap[\s\S]*?test\/component\/real-pi-fixture-state-preview\.test\.ts[\s\S]*?patched-command-preview must run without skipped tests[\s\S]*?grep -Fx '# skipped 0'/u
  )
  assert.match(
    gateScript,
    /patched-agent-preview\)[\s\S]*?--test-concurrency=1 --test-reporter=tap[\s\S]*?test\/component\/real-pi-fixture-agent-preview\.test\.ts[\s\S]*?patched-agent-preview must run without skipped tests[\s\S]*?grep -Fx '# skipped 0'/u
  )
  assert.ok(gateScript.includes(`readonly PATCHED_PI_STRESS_ITERATIONS=${PATCHED_PI_STRESS_ITERATIONS}`))
  assert.match(
    gateScript,
    /for \(\(stress_iteration = 1; stress_iteration <= PATCHED_PI_STRESS_ITERATIONS; stress_iteration \+= 1\)\); do/u
  )
  assert.match(gateScript, /--test-name-pattern="\$PATCHED_PI_STRESS_PATTERN"/u)
  assert.match(gateScript, /grep -Fx '# tests 2'/u)
  assert.match(gateScript, /grep -Fx '# pass 2'/u)
  assert.match(gateScript, /grep -Fx '# fail 0'/u)
  assert.match(gateScript, /grep -Fx '# skipped 0'/u)
  assert.match(
    gateScript,
    /patched-command-preview stress \$\{stress_iteration\}\/\$\{PATCHED_PI_STRESS_ITERATIONS\} passed/u
  )
  assert.ok(gateScript.includes(`readonly PATCHED_PI_AGENT_STRESS_ITERATIONS=${PATCHED_PI_AGENT_STRESS_ITERATIONS}`))
  assert.ok(
    gateScript.includes(`readonly PATCHED_PI_AGENT_SCHEDULE_ITERATIONS=${PATCHED_PI_AGENT_SCHEDULE_ITERATIONS}`)
  )
  assert.match(
    gateScript,
    /for \(\(stress_iteration = 1; stress_iteration <= PATCHED_PI_AGENT_STRESS_ITERATIONS; stress_iteration \+= 1\)\); do/u
  )
  assert.match(
    gateScript,
    /if \(\(stress_iteration <= PATCHED_PI_AGENT_SCHEDULE_ITERATIONS\)\); then[\s\S]*?stress_schedule='preflight'[\s\S]*?stress_schedule='provider-final'/u
  )
  assert.match(gateScript, /PI_ACP_C3_5_STRESS_SCHEDULE="\$stress_schedule"/u)
  assert.match(gateScript, /grep -Fx '# tests 1'/u)
  assert.match(gateScript, /grep -Fx '# pass 1'/u)
  assert.match(
    gateScript,
    /patched-agent-preview stress \$\{stress_iteration\}\/\$\{PATCHED_PI_AGENT_STRESS_ITERATIONS\} passed/u
  )
  assert.match(gateScript, /npm --version/u)
  assert.match(gateScript, /cp -a package\.json tsconfig\.json tsup\.config\.ts src/u)
  assert.match(gateScript, /ln -s \/workspace\/node_modules/u)
  assert.match(gateScript, /cd "\$\{build_root\}"/u)
  assert.match(gateScript, /--out-dir "\$\{build_output\}"/u)
  assert.match(gateScript, /test -s "\$\{build_output\}\/index\.js"/u)
  assert.match(gateScript, /git status --porcelain=v1 --untracked-files=all/u)
})
