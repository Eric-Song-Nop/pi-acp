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
  assert.match(realPi, /pi-0\.83\.0-raw-load-boundaries/u)
  assert.match(realPi, /pi-0\.83\.0-raw-strict-xfails/u)

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
    '/bin/bash .github/scripts/run-network-denied-ci.sh'
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

  for (const gate of ['typecheck', 'lint', 'test', 'build', 'load-boundaries', 'immutable-failures']) {
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
  assert.match(gateScript, /npm --version/u)
  assert.match(gateScript, /cp -a package\.json tsconfig\.json tsup\.config\.ts src/u)
  assert.match(gateScript, /ln -s \/workspace\/node_modules/u)
  assert.match(gateScript, /cd "\$\{build_root\}"/u)
  assert.match(gateScript, /--out-dir "\$\{build_output\}"/u)
  assert.match(gateScript, /test -s "\$\{build_output\}\/index\.js"/u)
  assert.match(gateScript, /git status --porcelain=v1 --untracked-files=all/u)
})
