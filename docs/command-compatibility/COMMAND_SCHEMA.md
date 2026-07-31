# Command compatibility schema

Checkpoint `C0.4` defines the vocabulary used by fixture manifests, the runtime
catalog, ACP metadata, and compatibility evidence.

The canonical executable contract is
[`src/acp/command-compatibility.ts`](../../src/acp/command-compatibility.ts).
[`command-compatibility.schema.json`](command-compatibility.schema.json) is the
JSON Schema companion for tools that do not execute TypeScript. Cross-field
identifier-prefix and safe-text checks remain authoritative in the Zod schema.

## Vocabulary

| Field             | Values                                                                         | Meaning                                                   |
| ----------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------- |
| `source`          | `adapter`, `pi-builtin`, `extension`, `prompt`, `skill`                        | The command router that owns the name                     |
| `compatibility`   | `rpc-native`, `basic-dialog`, `external-ui`, `tui-only`, `unknown`             | The least-capable headless interaction tier required      |
| `execution`       | `local`, `agent`, `session`, `unknown`                                         | The completion lifecycle the bridge must wait for         |
| `exposure`        | `stable`, `experimental`, `hidden`                                             | Whether the ACP command catalog may advertise the command |
| `interactions`    | `notify`, `select`, `confirm`, `input`, `editor`, `external-url`, `custom-tui` | Client resources required during execution                |
| `evidence[].kind` | `fixture`, `unit`, `e2e`, `manual`, `upstream`                                 | The durable evidence class supporting the classification  |

`sourceId` is an opaque identifier such as `extension:fx-local`. It must begin
with the `source` value and must never contain a filesystem path. `id` extends
that source ID with a normalized command segment, for example
`extension:fx-local:fx-local`. The display/execution name remains in `name`.

## Invariants

- `tui-only` commands are always `hidden`.
- `unknown` commands cannot be `stable`. If a feature flag exposes one as
  `experimental`, it must carry a visible `warning`.
- A `stable` command must use a headless tier and include durable evidence.
- `rpc-native` may only require `notify`.
- `basic-dialog` requires at least one of `select`, `confirm`, `input`, or
  `editor`.
- `external-ui` requires `external-url`.
- `custom-tui` always classifies the command as `tui-only`.
- Interaction entries are unique.
- Raw absolute paths and diagnostic details stay internal. ACP metadata receives
  only the safe ID, source, tiers, exposure, and interaction names.

The default policy is deliberately conservative:

| Compatibility tier                          | No evidence    | Evidence present |
| ------------------------------------------- | -------------- | ---------------- |
| `rpc-native`, `basic-dialog`, `external-ui` | `experimental` | `stable`         |
| `tui-only`, `unknown`                       | `hidden`       | `hidden`         |

An explicit feature flag may elevate `unknown` to `experimental`, but never to
`stable`.

## Example

```json
{
  "schemaVersion": 1,
  "id": "adapter:pi-acp:compact",
  "name": "compact",
  "source": "adapter",
  "sourceId": "adapter:pi-acp",
  "compatibility": "rpc-native",
  "execution": "local",
  "exposure": "stable",
  "interactions": [],
  "evidence": [
    {
      "kind": "unit",
      "ref": "test/unit/builtin-commands.test.ts"
    }
  ],
  "description": "Compact the current Pi session"
}
```

The compatibility object is not itself an ACP wire message. Runtime catalog
code must call `toSafeCommandMetadata()` and place the result under a
namespaced `_meta.piAcp` field.
