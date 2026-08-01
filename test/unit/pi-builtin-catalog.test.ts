import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import ts from 'typescript'
import { z } from 'zod'
import {
  ADAPTER_ONLY_COMMAND_NAMES,
  PI_BUILTIN_COMMAND_NAMES,
  REJECTED_PI_BUILTIN_COMMAND_NAMES,
  SUPPORTED_PI_BUILTIN_COMMAND_NAMES
} from '../../src/acp/pi-builtin-commands.js'
import { readCompatibilityMatrix } from '../helpers/compatibility-matrix.js'

const PI_PACKAGE = '@earendil-works/pi-coding-agent'
const BASELINE_VERSION = '0.83.0'

const EXPECTED_ORDERED_NAMES = [
  'settings',
  'model',
  'scoped-models',
  'export',
  'import',
  'share',
  'copy',
  'name',
  'session',
  'changelog',
  'hotkeys',
  'fork',
  'clone',
  'tree',
  'trust',
  'login',
  'logout',
  'new',
  'compact',
  'resume',
  'reload',
  'quit'
] as const

const EXPECTED_ADAPTER_HANDLED = ['export', 'name', 'session', 'changelog', 'compact'] as const

const EXPECTED_REJECTED = [
  'settings',
  'model',
  'scoped-models',
  'import',
  'share',
  'copy',
  'hotkeys',
  'fork',
  'clone',
  'tree',
  'trust',
  'login',
  'logout',
  'new',
  'resume',
  'reload',
  'quit'
] as const

const EXPECTED_ADAPTER_ONLY = ['autocompact', 'steering', 'follow-up'] as const

const commandNameSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u)
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u)
const gitHeadSchema = z.string().regex(/^[0-9a-f]{40}$/u)
const sha512IntegritySchema = z.string().regex(/^sha512-[A-Za-z0-9+/]{86}==$/u)

const versionEvidenceSchema = z
  .object({
    gitHead: gitHeadSchema,
    integrity: sha512IntegritySchema,
    sourceSha256: sha256Schema,
    distLeafSha256: sha256Schema,
    orderedNames: z.array(commandNameSchema)
  })
  .strict()

const catalogSchema = z
  .object({
    schemaVersion: z.literal(1),
    package: z.literal(PI_PACKAGE),
    repository: z.literal('earendil-works/pi'),
    sourcePath: z.literal('packages/coding-agent/src/core/slash-commands.ts'),
    distLeafPath: z.literal('dist/core/slash-commands.js'),
    versions: z
      .object({
        '0.80.5': versionEvidenceSchema,
        '0.83.0': versionEvidenceSchema
      })
      .strict(),
    adapterHandledPiBuiltins: z.array(commandNameSchema),
    rejectedPiBuiltins: z.array(commandNameSchema),
    adapterOnlyCommands: z.array(commandNameSchema)
  })
  .strict()

type Catalog = z.infer<typeof catalogSchema>

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'))
}

function readCatalog(): Catalog {
  return catalogSchema.parse(readJson('../fixtures/pi-builtin-catalog.json'))
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function propertyNameText(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text
  return null
}

function parseBuiltinNamesWithoutExecution(source: string): string[] {
  const sourceFile = ts.createSourceFile(
    'dist/core/slash-commands.js',
    source,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.JS
  )
  const declarations: ts.VariableDeclaration[] = []

  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'BUILTIN_SLASH_COMMANDS') {
      declarations.push(node)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)

  assert.equal(declarations.length, 1, 'expected exactly one static BUILTIN_SLASH_COMMANDS declaration')
  const initializer = declarations[0]!.initializer
  assert.ok(initializer && ts.isArrayLiteralExpression(initializer), 'builtin catalog must be a static array literal')

  const names = initializer.elements.map((element, index) => {
    assert.ok(ts.isObjectLiteralExpression(element), `builtin catalog entry ${String(index)} must be an object literal`)
    const nameProperties = element.properties.filter(
      (property): property is ts.PropertyAssignment =>
        ts.isPropertyAssignment(property) && propertyNameText(property.name) === 'name'
    )
    assert.equal(nameProperties.length, 1, `builtin catalog entry ${String(index)} must have exactly one name`)
    const name = nameProperties[0]!.initializer
    assert.ok(ts.isStringLiteral(name), `builtin catalog entry ${String(index)} name must be a string literal`)
    return name.text
  })

  assert.equal(new Set(names).size, names.length, 'builtin catalog names must be unique')
  return names
}

test('C1.5 fixture freezes both pinned Pi catalogs and the exact 5/17/3 partition', () => {
  const catalog = readCatalog()
  const minimum = catalog.versions['0.80.5']
  const baseline = catalog.versions['0.83.0']

  assert.deepEqual(minimum, {
    gitHead: 'cc62baa442b5c0333923fdfdcc1d7264f445b5b0',
    integrity: 'sha512-GPYFuHw1BN+3m5Gzw1HGH41WdFDzbplLauS0zYSf1ZOkgKFd6wtEAcjchB/vmz9YtTGbQOwECbsVj6GxZxungA==',
    sourceSha256: '788b87d9bbeb4498f9669de75e8233e63dcb9b6893179f497a1b6db61bd9a6b1',
    distLeafSha256: '9c0ec9e616b5577d80ef98632c40ca0332ac6125868e1a981307efc12d29d3a6',
    orderedNames: [...EXPECTED_ORDERED_NAMES]
  })
  assert.deepEqual(baseline, {
    gitHead: '845d6ff1f6643aba440341cce877ce1c43ebbc39',
    integrity: 'sha512-uYhF+FsZxogoSX/AxBcUdiY+ZklubwaXyAoEGA2eQwsHcyEAhUYIKh/WLXe/a8+k8eTCmxb+ZN2Zo9mzQtzbWw==',
    sourceSha256: '788b87d9bbeb4498f9669de75e8233e63dcb9b6893179f497a1b6db61bd9a6b1',
    distLeafSha256: '9c0ec9e616b5577d80ef98632c40ca0332ac6125868e1a981307efc12d29d3a6',
    orderedNames: [...EXPECTED_ORDERED_NAMES]
  })
  assert.deepEqual(catalog.adapterHandledPiBuiltins, [...EXPECTED_ADAPTER_HANDLED])
  assert.deepEqual(catalog.rejectedPiBuiltins, [...EXPECTED_REJECTED])
  assert.deepEqual(catalog.adapterOnlyCommands, [...EXPECTED_ADAPTER_ONLY])
  assert.deepEqual(PI_BUILTIN_COMMAND_NAMES, [...EXPECTED_ORDERED_NAMES])
  assert.deepEqual(SUPPORTED_PI_BUILTIN_COMMAND_NAMES, [...EXPECTED_ADAPTER_HANDLED])
  assert.deepEqual(REJECTED_PI_BUILTIN_COMMAND_NAMES, [...EXPECTED_REJECTED])
  assert.deepEqual(ADAPTER_ONLY_COMMAND_NAMES, [...EXPECTED_ADAPTER_ONLY])

  const handled = new Set<string>(catalog.adapterHandledPiBuiltins)
  assert.deepEqual(
    catalog.versions[BASELINE_VERSION].orderedNames.filter(name => handled.has(name)),
    catalog.adapterHandledPiBuiltins
  )
  assert.deepEqual(
    catalog.versions[BASELINE_VERSION].orderedNames.filter(name => !handled.has(name)),
    catalog.rejectedPiBuiltins
  )
  assert.equal(handled.size, 5)
  assert.equal(new Set(catalog.rejectedPiBuiltins).size, 17)
  assert.equal(new Set(catalog.adapterOnlyCommands).size, 3)
  const piBuiltinNames = new Set(catalog.versions[BASELINE_VERSION].orderedNames)
  for (const name of catalog.adapterOnlyCommands) {
    assert.equal(piBuiltinNames.has(name), false, `adapter-only command ${name} must not overlap the Pi catalog`)
  }
})

test('C1.5 fixture provenance matches the compatibility matrix pins', () => {
  const catalog = readCatalog()
  const matrix = readCompatibilityMatrix()

  assert.equal(matrix.pi.package, catalog.package)
  assert.deepEqual(
    {
      version: matrix.pi.minimumVersion,
      gitHead: matrix.pi.minimumGitHead,
      integrity: matrix.pi.minimumIntegrity
    },
    {
      version: '0.80.5',
      gitHead: catalog.versions['0.80.5'].gitHead,
      integrity: catalog.versions['0.80.5'].integrity
    }
  )
  assert.deepEqual(
    {
      version: matrix.pi.baselineVersion,
      gitHead: matrix.pi.baselineGitHead,
      integrity: matrix.pi.baselineIntegrity
    },
    {
      version: BASELINE_VERSION,
      gitHead: catalog.versions[BASELINE_VERSION].gitHead,
      integrity: catalog.versions[BASELINE_VERSION].integrity
    }
  )
})

test('C1.5 statically reads the installed 0.83.0 private catalog leaf without importing it', () => {
  const catalog = readCatalog()
  const publicEntryUrl = new URL(import.meta.resolve(PI_PACKAGE))
  assert.equal(publicEntryUrl.protocol, 'file:')
  const packageRootUrl = new URL('../', publicEntryUrl)

  const packageManifest = z
    .object({ name: z.literal(PI_PACKAGE), version: z.literal(BASELINE_VERSION) })
    .passthrough()
    .parse(JSON.parse(readFileSync(new URL('package.json', packageRootUrl), 'utf8')))
  const distLeafUrl = new URL(catalog.distLeafPath, packageRootUrl)
  const distLeafBytes = readFileSync(distLeafUrl)
  const distSourceMap = z
    .object({
      version: z.literal(3),
      file: z.literal('slash-commands.js'),
      sources: z.tuple([z.literal('../../src/core/slash-commands.ts')]),
      sourcesContent: z.tuple([z.string()])
    })
    .passthrough()
    .parse(JSON.parse(readFileSync(new URL(`${catalog.distLeafPath}.map`, packageRootUrl), 'utf8')))

  assert.equal(packageManifest.name, catalog.package)
  assert.equal(packageManifest.version, BASELINE_VERSION)
  assert.equal(sha256(distLeafBytes), catalog.versions[BASELINE_VERSION].distLeafSha256)
  assert.equal(
    sha256(Buffer.from(distSourceMap.sourcesContent[0], 'utf8')),
    catalog.versions[BASELINE_VERSION].sourceSha256
  )
  assert.deepEqual(
    parseBuiltinNamesWithoutExecution(distLeafBytes.toString('utf8')),
    catalog.versions[BASELINE_VERSION].orderedNames
  )
})
