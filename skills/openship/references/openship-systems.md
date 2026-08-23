# OpenShip Systems v1

OpenShip Systems is the advanced OpenShip capability. It publishes one self-contained JSON document containing a complete Sources snapshot, a typed architecture graph, and optional context for humans and agents.

Systems is JSON-only in v1. Legacy directory or YAML bundles are not canonical OpenShip Systems representations.

## Top-level document

```json
{
  "openship": "1.0",
  "capability": "systems",
  "source": {
    "manifest": { "openship": "1.0", "capability": "sources", "digest": "sha256:..." },
    "bundle": { "openship": "1.0", "capability": "sources", "digest": "sha256:...", "files": {} }
  },
  "system": {
    "id": "example-system",
    "name": "Example system",
    "rootNodeId": "s.root",
    "nodes": [],
    "edges": []
  }
}
```

`source.manifest` and `source.bundle` MUST form a valid, complete Sources snapshot. External URLs or omitted contents are not self-contained and are non-conformant.

See [schemas/systems.schema.json](schemas/systems.schema.json).

## Nodes and containment

Node kinds are closed in v1:

| Kind | Meaning |
|---|---|
| `Root` | The logical boundary of the described system. |
| `Host` | An execution environment or external platform. |
| `Container` | A grouped runtime unit hosted by a Host. |
| `Process` | A running service or executable component. |
| `Library` | A reusable code dependency outside runtime containment. |

Canonical node shape:

```json
{
  "id": "p.api",
  "kind": "Process",
  "name": "API",
  "parentId": "h.runtime",
  "sourceSelectors": ["apps/api/**", "packages/contracts/index.ts"],
  "metadata": { "runtime": "node", "ownership": "first_party" }
}
```

Rules:

- Every node has `metadata.ownership`, whose value is `first_party` or `third_party`.
- `first_party` means the system publisher owns or controls the component's implementation or operation. `third_party` means an external provider owns or controls it.
- Exactly one node has kind `Root`; its ID equals `rootNodeId` and it has no parent.
- Every Host has the Root as parent.
- Every Container has a Host parent.
- Every Process has a Host or Container parent.
- Library has no parent. Process and Library cannot contain children.
- IDs are unique and match `^[A-Za-z0-9._:-]+$`.
- The containment graph is acyclic.
- Metadata is open-ended beyond the required, typed `ownership` member. Boundary, ID prefixes, host naming, and other metadata are not required by v1.

### Source selectors

`sourceSelectors` is optional. An exact path selects itself. A selector ending in `/**` selects that directory and descendants. No other wildcard syntax is defined.

Every selector MUST match at least one Manifest path. Multiple nodes MAY select the same path and some source paths MAY remain unassigned.

## Edges

Edge types are closed in v1:

| Type | Source | Target | Cycle rule |
|---|---|---|---|
| `Runtime` | Process | Process or Container | Cycles allowed. |
| `Dataflow` | Process | Process or Container | Projected graph must be acyclic. |
| `Dependency` | Process | Library | Graph must be acyclic. |

```json
{
  "id": "e.api.database",
  "type": "Runtime",
  "fromNodeId": "p.api",
  "toNodeId": "p.database",
  "metadata": { "protocol": "pgwire", "layer7": "postgresql-sql" }
}
```

Root and Host cannot be edge endpoints under these rules. A Container target represents an opaque routing boundary.

## Optional context

`system.context` MAY contain concerns, shared documents, matrix assignments, system prompts, and node-local artifacts. Omitting context does not reduce graph conformance.

### Concerns

Concerns are explicitly declared. The recommended interoperable vocabulary is:

1. `Features`
2. `General Specs`
3. `General Skills`
4. `Data Model`
5. `Interfaces`
6. `Connectivity`
7. `Security`
8. `Implementation`
9. `Deployment`

Projects MAY use a subset and MAY declare additional concerns. Names are case-sensitive.

### Documents, skills, and prompts

Shared input kinds are `Document`, `Skill`, and `Prompt`:

```json
{
  "kind": "Document",
  "hash": "sha256:...",
  "title": "Public API contract",
  "language": "en",
  "text": "...",
  "supersedes": "sha256:..."
}
```

Compute the hash from UTF-8 bytes of:

```text
kind + "\n" + title + "\n" + language + "\n" + text
```

`supersedes` is excluded. Supersession chains MUST be acyclic. Missing predecessors are allowed so a snapshot need not contain its entire history.

Matrix assignments connect a node, a declared concern, and one or more `Document` or `Skill` hashes. References MUST resolve to documents of the corresponding kind.

Prompts are not ordinary matrix references. `systemPromptRefs` belongs to context, references only `Prompt` documents, and applies only to the Root.

### Artifacts

Artifact types are `Summary`, `Docs`, and `Code`. Each belongs to one node and one declared concern.

- Summary and Docs carry UTF-8 `text` and optional language.
- Code carries `sourcePaths` that resolve to Manifest files.
- Code MUST NOT duplicate file contents already present in the embedded Bundle.

Artifact IDs are unique within the system.

## Validation order

A consumer SHOULD validate in this order:

1. Top-level schema and embedded Sources.
2. Node IDs, root, containment, and parent kinds.
3. Edge endpoints and cycle rules.
4. Source selectors.
5. Concern declarations and document hashes.
6. Matrix, prompt, artifact, and supersession references.

Unknown metadata keys MUST be preserved. Unknown node, edge, document, or artifact kinds are invalid in v1.
