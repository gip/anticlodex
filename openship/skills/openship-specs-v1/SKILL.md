---
name: openship-specs-v1
description: "OpenShip v1 specification. Use this skill whenever working with OpenShip system descriptions, validating payloads, generating or parsing OpenShip file-based or JSON representations, or building tooling that reads/writes the OpenShip format. Covers the node and edge model, concern matrix, shared input documents, node-local artifacts, hash identity, and conformance rules."
---

# OpenShip v1 Specification

Status: Draft v1 (normative where stated)

## 1. Purpose and Scope

OpenShip v1 defines a portable way to describe and share the architecture and implementation state of a software product.

OpenShip models a system as interconnected nodes plus a concern matrix (`node × concern`) that links reusable input documents to each node.

This specification defines:

- the node and edge model
- the concern matrix model
- shared input document types (`Document`, `Skill`, `Prompt`)
- node-local output artifact types (`Summary`, `Code`, `Docs`)
- a canonical file-based representation
- a canonical JSON representation
- strict validation rules
- extensibility and compatibility guidance

## 2. Terminology and Conventions

### 2.1 Normative Language

The key words `MUST`, `MUST NOT`, `SHOULD`, `SHOULD NOT`, and `MAY` are to be interpreted as normative requirements.

### 2.2 Core Terms

- **Node**: a typed architectural element (`Root`, `Host`, `Container`, `Process`, `Library`).
- **Edge**: a directed, typed connection between eligible node endpoints.
- **Concern**: a category used in the matrix (for example, `Interfaces`).
- **Cell**: one `(node, concern)` entry in the matrix.
- **Input Document**: reusable shared source content (`Document`, `Skill`, `Prompt`).
- **Artifact**: output content produced for a single node (`Summary`, `Code`, `Docs`).
- **Content Hash**: deterministic identifier derived from canonical content.
- **NodeKind**: `Root` | `Host` | `Container` | `Process` | `Library`.
- **DocKind**: `Document` | `Skill` | `Prompt`.
- **MatrixRefKind**: `Document` | `Skill` | `Prompt`.
- `Prompt` is a constrained matrix reference kind: attach-only to root via `__system_prompt__`.

### 2.3 Identifier Formats

- Shared document IDs MUST be content hashes in the form `sha256:<64 lowercase hex chars>`.
- Node IDs, edge IDs, and artifact IDs MUST be unique within a system payload.
- IDs MUST match regex `^[a-zA-Z0-9._:-]+$`. Payloads containing IDs that violate this pattern MUST be rejected by conforming validators.

## 3. Core Model and Graph Semantics

An OpenShip system is composed of:

- exactly one `Root` node
- zero or more `Host`, `Container`, `Process`, and `Library` nodes
- zero or more typed edges
- a concern matrix over all nodes
- global shared input document stores
- node-local output artifacts

The model has two graph dimensions:

- **Containment graph** (parent-child): host/container/process hierarchy.
- **Connectivity graph** (edges): directed runtime/data connections.

Rules:

- `Root` is freestanding and MUST NOT participate in edges.
- `Library` nodes may participate in `Dependency` edges only (see Section 5).
- Input documents are shared, reusable, and globally stored at system scope.
- Artifacts are node-local outputs and MUST NOT be shared across nodes.

A `Host` node with no `parentId` is implicitly contained by the `Root` node. This does not alter the `Root` node's freestanding status for edge purposes; it only establishes logical containment scope.

## 4. Node Types

### 4.1 Node Kind Definitions

- **Root**: logical root for the full product description.
- **Host**: execution environment that may contain containers and/or processes.
- **Container**: grouped runtime unit that may contain processes.
- **Process**: executable runtime component.
- **Library**: reusable code module, freestanding for containment in v1.

### 4.2 Allowed Containment

- `Host` MAY contain `Container` and `Process`.
- `Container` MAY contain `Process`.
- `Process` MUST be a child of either `Host` or `Container` and MUST NOT be a child of `Process`.
- `Process` MUST NOT contain children.
- `Library` MUST be freestanding (no parent, no children).
- `Root` MUST be freestanding for containment (no parent).
- `Host` nodes without a `parentId` are implicitly scoped under the `Root` node.

### 4.3 Canonical Node Shape

```json
{
  "id": "p.api",
  "kind": "Process",
  "name": "API",
  "parentId": "c.backend",
  "metadata": {
    "ownership": "first_party",
    "boundary": "internal",
    "runtime": "node",
    "language": "typescript"
  },
  "matrix": {
    "Interfaces": {
      "documentRefs": ["sha256:..."],
      "skillRefs": ["sha256:..."]
    }
  }
}
```

Field requirements:

- `id`, `kind`, `name`, `matrix` are REQUIRED.
- `parentId` is REQUIRED for `Container` and `Process`; forbidden for `Root` and `Library`; optional for `Host`.
- `metadata` is REQUIRED.
- `metadata.ownership` is REQUIRED and MUST be `first_party` or `third_party`.
- `metadata.boundary` is REQUIRED and MUST be `internal` or `external`.
- `matrix` keys MUST reference known concerns.

### 4.4 Host Ownership Naming Convention

- Host names are ownership-based labels.
- For hosts with `metadata.ownership = "first_party"`, `name` MUST start with `First-Party Host`.
- For hosts with `metadata.ownership = "third_party"`, `name` MUST start with `Third-Party Service Host` or `External Service Host`.
- Qualifiers MAY be appended for specificity, for example `First-Party Host (Vercel)` or `Third-Party Service Host (Auth0)`.

## 5. Edge Model and Metadata

Edges describe directed runtime, data, or dependency interactions between nodes.

### 5.1 Edge Types

OpenShip v1 defines three edge types:

| Edge Type | Semantics | Constraints |
|-----------|-----------|-------------|
| `Runtime` | Synchronous or asynchronous runtime communication (HTTP, gRPC, message queues) | Cycles permitted. Source: `Process`. Target: `Process` or `Container`. |
| `Dataflow` | Directed data pipeline or transformation dependency | MUST be acyclic (DAG). Source: `Process`. Target: `Process` or `Container`. |
| `Dependency` | Build-time or code-level dependency on a library | MUST be acyclic (DAG). Source: `Process`. Target: `Library`. |

### 5.2 Canonical Edge Shape

```json
{
  "id": "e.api.db",
  "type": "Runtime",
  "fromNodeId": "p.api",
  "toNodeId": "p.db",
  "metadata": {
    "layer7": "postgresql-sql",
    "protocol": "pgwire",
    "speedMbps": 1000,
    "latencyMs": 2,
    "notes": "primary DB path"
  }
}
```

### 5.3 Network Connection Conventions

For `Runtime`/`Dataflow` edges, implementations and authored bundles SHOULD encode connection semantics in metadata:

- `metadata.protocol` SHOULD describe the transport-level protocol and SHOULD be used for compatibility checks. Examples include `"http"`, `"grpc"`, `"pgwire"`, `"filesystem"`.
- `metadata.layer7` SHOULD describe the application-layer protocol for topology readability and routing intent. Examples include:
  - `"rest-json"`
  - `"grpc-json"`
  - `"oidc-oauth2"`
  - `"oidc-oauth2-pkce"`

Tooling SHOULD display `metadata.layer7` first when rendering edge labels; if absent, it MAY fallback to `metadata.protocol`.

### 5.4 Endpoint Rules

- For `Runtime` and `Dataflow` edges: `fromNodeId` MUST reference a `Process` node. `toNodeId` MUST reference a `Process` or `Container` node.
- For `Dependency` edges: `fromNodeId` MUST reference a `Process` node. `toNodeId` MUST reference a `Library` node.
- Edges to or from `Root` are forbidden for all edge types.

### 5.5 Edge Target Semantics for Containers

When a `Runtime` or `Dataflow` edge targets a `Container` node, this represents an opaque routing boundary. The edge indicates that the source Process communicates with the Container as a unit, without specifying which internal Process handles the interaction. Tooling SHOULD interpret this as: the Container exposes a stable entry point (such as a load balancer, ingress, or service mesh endpoint) and internal routing is an implementation detail.

For analysis or flattening purposes, tooling MAY expand a Container-targeted edge into individual Process-targeted edges based on the Container's children, but this expansion is not required for conformance.

### 5.6 Metadata Rules

- `metadata.protocol` is OPTIONAL. When present, it describes the wire protocol (e.g., `"http"`, `"grpc"`, `"pgwire"`, `"filesystem"`).
- `metadata.layer7` is OPTIONAL. When present, it describes the application-layer protocol family (e.g., `"rest-json"`, `"grpc-json"`), and MAY be used by topology renderers as the preferred edge label.
- `metadata.description` is OPTIONAL. A short human-readable description of the edge's purpose.
- `metadata.speedMbps` is OPTIONAL numeric throughput.
- Additional metadata fields MAY be included.

## 6. Concern Matrix (`node × concern`)

### 6.1 Baseline Concerns

The OpenShip v1 baseline concern set, with scoping guidance:

| Concern | Scope |
|---------|-------|
| `Features` | Functional and non-functional requirements allocated to a node. |
| `General Specs` | Cross-cutting design specifications not captured by a domain-specific concern. |
| `General Skills` | Cross-cutting execution guidance not captured by a domain-specific concern. |
| `Data Model` | Schema, entity relationships, and data lifecycle for a node. |
| `Interfaces` | API contracts, message schemas, and integration surfaces. |
| `Connectivity` | Network topology, service discovery, and routing configuration. |
| `Security` | Authentication, authorization, encryption, and threat model. |
| `Implementation` | Language, framework, and architectural pattern choices. |
| `Deployment` | Build, packaging, release, and infrastructure configuration. |

### 6.2 Extensible Concern Registry

A system MAY define additional concerns (for example `Performance`, `Measurement`).

Rules:

- Baseline concerns MUST retain exact spelling.
- Additional concerns MUST be listed in the system concern registry.
- Unknown concerns SHOULD be preserved by tooling even if ignored.

### 6.3 Cell Model

Each cell contains only input document references:

```json
{
  "documentRefs": ["sha256:..."],
  "skillRefs": ["sha256:..."]
}
```

Rules:

- Arrays MAY be empty.
- References MUST resolve in shared document stores.
- A single input document MAY be referenced by multiple cells across multiple nodes.
- `Prompt` is not represented inside standard matrix cell references.

## 7. Input Documents and Output Artifacts

### 7.1 Shared Input Documents (Reusable)

Input document types:

- **Document**: general product requirements, design notes, and implementation-level narrative.
- **Skill**: domain knowledge, execution guidance, and workflow instructions.
- **Prompt**: system-level instruction block used as global system prompt context.

Canonical shared document shape:

```json
{
  "kind": "Document",
  "hash": "sha256:...",
  "title": "Public API authentication",
  "language": "en",
  "text": "..."
}
```

Rules:

- `kind` is REQUIRED and MUST be one of `Document`, `Skill`, or `Prompt`.
- `language` SHOULD be BCP-47 (`en` default).
- `text` MAY be Markdown or plain text.
- Input documents are system-scoped shared assets.

`Prompt` documents are a distinct kind with explicit restrictions:

- They MUST be local documents in editor-created flows.
- They MUST use `sourceType = "local"` in any implementation that supports source types.
- They MUST be attached only to the system `Root` node.
- They MUST use concern `__system_prompt__` (hidden system concern).
- Prompt attachments are represented as `Prompt` reference types and do not occupy normal matrix concern cells in all tooling flows.

### 7.2 Output Artifacts (Node-Local, Non-Shared)

Artifact types:

- **Summary**: short synthesis of implementation or changes.
- **Code**: a set of source files belonging to a node, stored as real files on disk in the file-based representation.
- **Docs**: implementation documentation.

Canonical artifact shape (Summary, Docs):

```json
{
  "id": "a.p.api.interfaces.summary.v1",
  "nodeId": "p.api",
  "concern": "Interfaces",
  "type": "Summary",
  "text": "...",
  "language": "en"
}
```

Code artifact shape:

```json
{
  "id": "a.p.api.interfaces.code.v1",
  "nodeId": "p.api",
  "concern": "Interfaces",
  "type": "Code",
  "files": [
    { "filePath": "src/routes/auth.ts", "fileContent": "export ..." }
  ]
}
```

Code artifact rules:

- In the file-based representation, code files are stored as real files on disk under `nodes/<nodeId>/artifacts/code/` (see Section 10). The `filePath` is relative to that directory.
- In the JSON representation, code files are inline as `filePath` + `fileContent` pairs.
- A single file MAY be referenced by multiple `Code` artifacts within the same node. The file exists once on disk; multiple artifacts may list it.
- File content MUST be valid UTF-8 without NUL bytes.

General artifact rules:

- Every artifact MUST belong to exactly one node (`nodeId`).
- Artifacts MUST NOT be referenced by other nodes.
- Artifact IDs MUST be unique within the system.

## 8. Input Document Versioning

### 8.1 Problem Statement

Because input documents are content-addressed, any change to a document's text, title, kind, or language produces a new hash and thus a new document identity. Without additional structure, there is no way to express that one document is a revision of another.

### 8.2 Supersedes Relation

An input document MAY include an optional `supersedes` field containing the hash of the document it replaces:

```json
{
  "kind": "Document",
  "hash": "sha256:new...",
  "title": "API auth contract v2",
  "language": "en",
  "text": "...",
  "supersedes": "sha256:old..."
}
```

### 8.3 Rules

- `supersedes` is OPTIONAL. When absent, the document is treated as an original (no predecessor).
- The `supersedes` hash SHOULD reference a document of the same kind, but cross-kind supersession is permitted.
- Supersession chains MUST be acyclic. Tooling SHOULD detect and reject cycles.
- The superseded document MAY still exist in the store for historical purposes. Tooling MUST NOT require the superseded document to be present for validation to pass.

### 8.4 Hash Computation

The `supersedes` field is excluded from hash computation (see Section 12). This means a document's identity is determined by `kind`, `title`, `language`, and `text`. The supersedes relation is metadata layered on top of content identity.

### 8.5 Artifact Versioning

Artifact IDs are opaque local identifiers. This specification does not mandate a versioning scheme for artifacts. However, the convention of suffixing with `.v1`, `.v2`, etc. is RECOMMENDED for human readability. Tooling MAY implement artifact version tracking as an extension.

## 9. Normative Validation Rules

A payload is OpenShip v1 conformant only if all rules pass.

1. Exactly one node has `kind = Root`.
2. All node IDs are unique.
3. All edge IDs are unique.
4. All artifact IDs are unique.
5. Containment graph is acyclic.
6. `Root` and `Library` are freestanding and have no parent.
7. `Host` may parent only `Container` or `Process`.
8. `Container` may parent only `Process`.
9. `Process` may only have parent `Host` or `Container`.
10. `Process` and `Library` have no children.
11. Every edge MUST have a `type` field with value `Runtime`, `Dataflow`, or `Dependency`.
12. For `Runtime` and `Dataflow` edges: source MUST be `Process`; target MUST be `Process` or `Container`.
13. For `Dependency` edges: source MUST be `Process`; target MUST be `Library`.
14. No edge of any type may include `Root` as source or target.
15. The projected graph of `Dataflow` edges (Process-to-Process only) MUST be a DAG. `Runtime` edges are exempt from cycle constraints.
16. The projected graph of `Dependency` edges MUST be a DAG.
17. All matrix concern keys are declared in concern registry.
18. All `documentRefs` resolve in shared document store.
19. All `skillRefs` resolve in shared document store.
20. `Prompt` references MUST be attached only via `__system_prompt__` on the system root node.
21. Shared document hashes MUST match canonical hash algorithm (Section 12).
22. Baseline concerns MUST exist in registry with exact names.
23. Artifacts MUST reference an existing node.
24. All IDs MUST match regex `^[a-zA-Z0-9._:-]+$`.
25. Supersession chains in input documents MUST be acyclic.
26. Code artifact `filePath` values MUST be valid relative paths (no `..`, no absolute paths, no NUL bytes).
27. Every node MUST define `metadata.ownership` (`first_party` or `third_party`) and `metadata.boundary` (`internal` or `external`).
28. Every `Host` node `name` MUST follow the ownership naming convention in Section 4.4.

## 10. File-Based Canonical Representation

### 10.1 Directory Layout

```text
.
├── openship.yaml
├── inputs
│   ├── documents
│   │   └── <hash>.md
│   └── skills
│       └── <hash>.md
├── nodes
│   └── <nodeId>
│       ├── node.yaml
│       └── artifacts
│           ├── summary
│           │   └── <artifactId>.md
│           ├── docs
│           │   └── <artifactId>.md
│           └── code
│               └── <real source files>
└── edges
    └── edges.yaml
```

Code files live as real files on disk under `nodes/<nodeId>/artifacts/code/`. They can be opened, edited, linted, and compiled directly by any tool (including Claude Code). The `node.yaml` manifest tracks which files belong to which `Code` artifact.

### 10.2 Root Manifest (`openship.yaml`)

OpenShip file-based bundles MUST use `s.root` as the canonical root system node identifier.

```yaml
specVersion: openship/v1
systemNodeId: s.root
concerns:
  - Features
  - General Specs
  - General Skills
  - Data Model
  - Interfaces
  - Connectivity
  - Security
  - Implementation
  - Deployment
```

### 10.3 Input Document Files

Each shared input document is Markdown with front matter:

```markdown
---
kind: Document
hash: sha256:8f...
title: API auth contract
language: en
supersedes: sha256:7a...    # optional
---

Document body in Markdown.
```

`kind` for regular inputs is `Document` or `Skill`.
`Prompt` is managed as system prompt metadata and attached to the root node via concern `__system_prompt__`.

Rules:

- `kind` determines store placement (`documents` or `skills`); `Prompt` is a system-level attachment, not a normal matrix concern cell document entry.
- Filename MUST equal `<hash>.md`.
- Front matter `hash` MUST equal filename hash.

### 10.3.1 Prompt Attachment Metadata

- Prompt attachments are root-only, using concern `__system_prompt__`.
- In a pure JSON/DB model, this is represented as a `Prompt` reference on the system root node.
- In file exports, represent prompt attachments as implementation-defined sidecar metadata tied to the root manifest/node.

### 10.4 Node Manifest (`nodes/<nodeId>/node.yaml`)

```yaml
id: p.api
kind: Process
name: API
parentId: c.backend
metadata:
  ownership: first_party
  boundary: internal
  runtime: node
matrix:
  Interfaces:
    documentRefs: [sha256:aaa...]
    skillRefs: [sha256:ccc...]
  Security:
    documentRefs: []
    skillRefs: [sha256:ddd...]
artifacts:
  Summary:
    - a.p.api.interfaces.summary.v1
  Docs:
    - a.p.api.interfaces.docs.v1
  Code:
    - id: a.p.api.interfaces.code.v1
      concern: Interfaces
      files:
        - src/routes/auth.ts
        - src/middleware/session.ts
```

The `Code` artifact entries in `node.yaml` list the artifact ID, concern, and the file paths relative to `nodes/<nodeId>/artifacts/code/`. The actual source files exist at those paths on disk:

```text
nodes/p.api/
├── node.yaml
└── artifacts/
    ├── summary/
    │   └── a.p.api.interfaces.summary.v1.md
    ├── docs/
    │   └── a.p.api.interfaces.docs.v1.md
    └── code/
        └── src/
            ├── routes/
            │   └── auth.ts
            └── middleware/
                └── session.ts
```

### 10.5 Artifact Files

- `Summary` and `Docs` artifacts are Markdown files with front matter:

```markdown
---
id: a.p.api.interfaces.summary.v1
nodeId: p.api
concern: Interfaces
type: Summary
language: en
---

Summary text.
```

- `Code` artifacts are real source files on disk. There is no wrapper format — the files are stored directly. The artifact-to-file mapping is maintained in `node.yaml` (see Section 10.4).

### 10.6 Edge List (`edges/edges.yaml`)

```yaml
edges:
  - id: e.api.db
    type: Runtime
    fromNodeId: p.api
    toNodeId: p.db
    metadata:
      layer7: postgresql-sql
      protocol: pgwire
      speedMbps: 1000
  - id: e.api.authlib
    type: Dependency
    fromNodeId: p.api
    toNodeId: lib.auth
    metadata:
      description: Authentication utility library
```

### 10.7 Generated-Spec Requirement

- Generated OpenShip directories must include this specification as a skill artifact: `SKILLS.md`.
- The file must be included in the generated artifact bundle (for example at bundle root or the standard skill directory used by your exporter).
- This is a packaging/output requirement only and does **not** require registration in the project skill catalog or runtime skill registry.

## 11. JSON-Based Canonical Full-System Representation

### 11.1 Canonical Top-Level Shape

```json
{
  "specVersion": "openship/v1",
  "concerns": [
    "Features",
    "General Specs",
    "General Skills",
    "Data Model",
    "Interfaces",
    "Connectivity",
    "Security",
    "Implementation",
    "Deployment"
  ],
  "documentsByHash": {
    "sha256:1111111111111111111111111111111111111111111111111111111111111111": {
      "kind": "Document",
      "hash": "sha256:1111111111111111111111111111111111111111111111111111111111111111",
      "title": "User login",
      "language": "en",
      "text": "Users can authenticate via OIDC."
    },
    "sha256:2222222222222222222222222222222222222222222222222222222222222222": {
      "kind": "Prompt",
      "hash": "sha256:2222222222222222222222222222222222222222222222222222222222222222",
      "title": "System prompt",
      "language": "en",
      "text": "You are a systems design assistant."
    }
  },
  "nodes": [],
  "edges": [],
  "artifacts": []
}
```

`documentsByHash` stores shared documents for all `DocKind` values; an implementation MAY keep a dedicated `skillsByHash` structure, but all entries are equivalent in canonical semantics when keyed by hash and `kind`.
In the JSON representation, `Code` artifacts include file content inline as `filePath` + `fileContent` pairs. When converting from the file-based representation, tooling reads each real file and populates `fileContent`. When converting to the file-based representation, tooling writes each `fileContent` to its corresponding file path on disk.

### 11.2 Canonical Ordering for Deterministic Exports

For deterministic serialization, tools SHOULD sort: concerns by declared order in manifest; nodes, edges, and artifacts by `id`; and map keys lexicographically.

## 12. Hash Identity and Canonicalization Rules

### 12.1 Shared Document Hash Algorithm

Given a shared document, compute its hash from the following canonical payload:

```text
kind + "\\n" + title + "\\n" + language + "\\n" + text
```

Procedure:

1. Construct the payload string by concatenating `kind`, `title`, `language`, and `text` with newline separators.
2. Encode as UTF-8 bytes without BOM.
3. Compute SHA-256 digest.
4. Encode as lowercase hex.
5. Prefix with `sha256:` to form the document hash.

The `supersedes` field, if present, is NOT included in hash computation. This means a document's hash is determined solely by its content identity (`kind`, `title`, `language`, `text`).

### 12.2 Artifact Identity

Artifact IDs are not shared references; they are local identifiers. Artifact IDs MUST be unique per system payload. Artifact IDs SHOULD be deterministic when generated from content and `nodeId`.

### 12.3 Canonicalization Goals

Canonicalization ensures: stable hashes across file-based and JSON representations, safe deduplication and cross-node reuse for shared input documents, and deterministic round-trip conversion.

## 13. Extensibility and Versioning

### 13.1 Spec Versioning

- `specVersion` MUST be present.
- OpenShip v1 uses `openship/v1`.

### 13.2 Backward-Compatible Extension Points

- `metadata` objects on nodes and edges are open-ended.
- Additional concerns are allowed via concern registry.
- Unknown metadata keys MUST be preserved by compliant tooling.

### 13.3 Breaking Changes

The following require a new major spec version:

- changing node kind semantics
- changing edge endpoint rules or type definitions
- changing shared document hash algorithm
- changing canonical artifact type meanings (`Summary`, `Code`, `Docs`)

### 13.4 Payload Size Guidance

This specification does not impose hard size limits. However, implementations SHOULD enforce reasonable operational limits. Recommended maximums:

- Individual text field (document text, artifact text): 1 MB.
- Individual code file content: 1 MB.
- Total payload size (JSON representation): 100 MB.
- Individual filename in file-based representation: 255 bytes (to respect common filesystem limits).

Implementations MAY impose stricter limits and SHOULD document them.

## 14. End-to-End Examples

### 14.1 Minimal JSON Example

```json
{
  "specVersion": "openship/v1",
  "concerns": [
    "Features", "General Specs", "General Skills",
    "Data Model", "Interfaces", "Connectivity",
    "Security", "Implementation", "Deployment"
  ],
  "documentsByHash": {
    "sha256:1111111111111111111111111111111111111111111111111111111111111111": {
      "kind": "Document",
      "hash": "sha256:1111111111111111111111111111111111111111111111111111111111111111",
      "title": "User login",
      "language": "en",
      "text": "Users can authenticate via OIDC."
    }
  },
  "nodes": [
    {
      "id": "s.root",
      "kind": "Root",
      "name": "Example System",
      "metadata": {
        "ownership": "first_party",
        "boundary": "internal"
      },
      "matrix": {
        "Features": {
          "documentRefs": ["sha256:1111111111111111111111111111111111111111111111111111111111111111"],
          "skillRefs": []
        }
      }
    },
    {
      "id": "h.main",
      "kind": "Host",
      "name": "First-Party Host (Main)",
      "metadata": {
        "ownership": "first_party",
        "boundary": "internal"
      },
      "matrix": {}
    },
    {
      "id": "p.api",
      "kind": "Process",
      "name": "API",
      "parentId": "h.main",
      "metadata": {
        "ownership": "first_party",
        "boundary": "internal",
        "runtime": "node"
      },
      "matrix": {}
    },
    {
      "id": "p.worker",
      "kind": "Process",
      "name": "Worker",
      "parentId": "h.main",
      "metadata": {
        "ownership": "first_party",
        "boundary": "internal"
      },
      "matrix": {}
    },
    {
      "id": "lib.auth",
      "kind": "Library",
      "name": "Auth Library",
      "metadata": {
        "ownership": "first_party",
        "boundary": "internal"
      },
      "matrix": {}
    }
  ],
  "edges": [
    {
      "id": "e.api.worker",
      "type": "Runtime",
      "fromNodeId": "p.api",
      "toNodeId": "p.worker",
      "metadata": { "protocol": "grpc" }
    },
    {
      "id": "e.api.authlib",
      "type": "Dependency",
      "fromNodeId": "p.api",
      "toNodeId": "lib.auth",
      "metadata": { "description": "Authentication utility library" }
    }
  ],
  "artifacts": [
    {
      "id": "a.p.api.impl.summary.v1",
      "nodeId": "p.api",
      "concern": "Implementation",
      "type": "Summary",
      "language": "en",
      "text": "Initial API scaffold created."
    },
    {
      "id": "a.p.api.interfaces.code.v1",
      "nodeId": "p.api",
      "concern": "Interfaces",
      "type": "Code",
      "files": [
        {
          "filePath": "src/routes/auth.ts",
          "fileContent": "export const authRoute = ..."
        }
      ]
    }
  ]
}
```

This example stores a `Prompt` document in the shared document store; tool output must still attach it via root concern `__system_prompt__` as `Prompt` metadata, not as a normal concern cell reference.

### 14.2 File-Based Example

Given the JSON above, the file-based representation would be:

```text
.
├── openship.yaml
├── inputs
│   └── documents
│       └── sha256:1111...1111.md
├── nodes
│   ├── s.root
│   │   └── node.yaml
│   ├── h.main
│   │   └── node.yaml
│   ├── p.api
│   │   ├── node.yaml
│   │   └── artifacts
│   │       ├── summary
│   │       │   └── a.p.api.impl.summary.v1.md
│   │       └── code
│   │           └── src
│   │               └── routes
│   │                   └── auth.ts        ← real file
│   ├── p.worker
│       └── node.yaml
│   └── lib.auth
│       └── node.yaml
└── edges
    └── edges.yaml
```

The `auth.ts` file contains the actual source code, not a YAML wrapper. The `node.yaml` for `p.api` tracks the artifact-to-file mapping.

### 14.3 Reuse and Supersession Example

One `Document` hash may appear in multiple cells across multiple nodes. When a document is revised, the new document may reference the old via `supersedes`, enabling tooling to track revision history while all matrix cells continue to reference the appropriate version by hash.

### 14.4 Round-Trip Requirement

A conforming converter MUST preserve semantic content when converting between file-based and JSON canonical representations. Preserved content includes IDs, hashes, concern assignments, matrix references, artifact ownership, edge types, supersession relations, and code file content.

## 15. Conformance Checklist

A producer/consumer is OpenShip v1 conformant when it satisfies all of the following:

- Parses and emits `specVersion: openship/v1`.
- Supports baseline concern names exactly.
- Validates `kind` for nodes against `NodeKind`.
- Requires `metadata.ownership` + `metadata.boundary` on every node with allowed enum values.
- Enforces ownership-based host naming (`First-Party Host`, `Third-Party Service Host`, `External Service Host`).
- Preserves unknown concerns and metadata fields.
- Validates node containment and edge endpoint rules per edge type.
- Validates matrix reference kinds against `MatrixRefKind` (`Document`, `Skill`, `Prompt`) with `Prompt` constrained to system prompt rules.
- Validates DAG constraint for `Dataflow` and `Dependency` edges only (not `Runtime` edges).
- Validates shared document hash references and hash format.
- Validates that `kind` in stored documents matches the documented kinds (`Document`, `Skill`, `Prompt`).
- Supports reusable shared docs with optional `supersedes`.
- Enforces system prompt constraints (root node attachment + `__system_prompt__`, local source).
- Enforces node-local artifact ownership (no cross-node artifact sharing).
- Stores `Code` artifact files as real files on disk in the file-based representation.
- Reads `Code` artifact file content inline in the JSON representation.
- Supports file-based canonical representation.
- Supports JSON-based canonical representation.
- Preserves semantics across round-trip conversion.
- Requires generated directories to include `SKILLS.md` as the OpenShip specification artifact.
- Rejects IDs not matching the normative regex pattern.

---

*— End of OpenShip v1 Specification —*
