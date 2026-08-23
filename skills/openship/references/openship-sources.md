# OpenShip Sources v1

OpenShip Sources lets a running project publish the exact source snapshot that produced it. A client starting with only the origin can retrieve, verify, and materialize that snapshot without a repository provider or version-control history.

Read [openship.md](openship.md) first for discovery, transport, and caching rules.

## Endpoints

Discovery advertises two required and three optional URLs:

| Link | Required | Meaning |
|---|---:|---|
| `manifest` | Yes | Project identity and file metadata, without content. |
| `bundle` | Yes | Every file's encoded content in one JSON document. |
| `file` | No | Raw content for one manifest path. |
| `archive` | No | The manifest file set as a compressed archive. |
| `instructions` | No | Plain-language project-specific retrieval guidance. |

All reads are public, CORS-readable GET requests.

## Manifest

```json
{
  "openship": "1.0",
  "capability": "sources",
  "generatedAt": "2026-08-21T12:00:00.000Z",
  "digest": "sha256:1c413f...",
  "project": {
    "name": "Example",
    "description": "An example project.",
    "homepage": "https://example.com",
    "repository": "https://github.com/example/example",
    "license": "MIT"
  },
  "totals": { "files": 2, "bytes": 42 },
  "files": [
    {
      "path": "app/page.tsx",
      "size": 30,
      "sha256": "0f1e2d...",
      "encoding": "utf-8",
      "mediaType": "text/plain; charset=utf-8",
      "type": "file"
    }
  ]
}
```

Required members are `openship`, `capability`, `digest`, `project`, `totals`, and `files`. Project name and description are required. Repository, commit, stack, structure, setup, runtime, environment-variable names, ignore rules, generation time, lineage, and other metadata are optional.

See [schemas/sources-manifest.schema.json](schemas/sources-manifest.schema.json).

### File entries

Every entry MUST contain:

- `path`: a repository-relative NFC string using `/` separators.
- `size`: the raw byte length.
- `sha256`: 64 lowercase hexadecimal characters over the raw bytes.
- `encoding`: `utf-8` or `base64` for JSON transport.
- `mediaType`: the media type used by a file endpoint.
- `type`: `file` or `symlink`.

Paths MUST NOT begin with `/`, contain `\`, contain an empty, `.` or `..` segment, contain a NUL byte, or exceed 512 UTF-8 bytes. Paths MUST be unique and sorted by ascending UTF-8 bytes.

A symlink MUST include its repository-relative `target`. Its size and SHA-256 describe the bytes served by Bundle and File after resolving the declared target. An archive MAY preserve the link itself.

### Optional metadata

An `env` array contains environment-variable names only. It MUST NOT contain values. Commit metadata is informational: if a working tree was dirty, `commit.dirty` MUST be true and clients MUST NOT treat the commit SHA as the snapshot identity. The Sources digest is authoritative.

## Bundle

```json
{
  "openship": "1.0",
  "capability": "sources",
  "digest": "sha256:1c413f...",
  "files": {
    "app/page.tsx": {
      "encoding": "utf-8",
      "content": "export default function Page() {}\n"
    },
    "public/logo.png": {
      "encoding": "base64",
      "content": "iVBORw0KGgo..."
    }
  }
}
```

The Bundle `digest` MUST equal the Manifest digest. Its file keys MUST exactly equal the Manifest paths. Each entry's encoding MUST match its Manifest entry.

UTF-8 content MUST survive an encode/decode round trip. Base64 MUST use the standard alphabet and decode canonically; padded and unpadded input MAY be accepted, but producers SHOULD emit padded base64.

See [schemas/sources-bundle.schema.json](schemas/sources-bundle.schema.json).

## Digest

Compute the snapshot digest from Manifest file entries sorted by the UTF-8 bytes of `path`:

```text
digest = "sha256:" + SHA256(
  concat(path + "\0" + sha256_hex + "\n")
)
```

`sha256_hex` is the lowercase, unprefixed file hash. Size, encoding, media type, file type, target, project metadata, and generation time do not enter the digest.

Two conforming snapshots with the same digest contain the same paths and raw bytes. The digest does not claim that unlisted files do not exist on the server; publication safety comes from the declared file-set requirement.

## Declared file set

A producer MUST derive the published set from a fail-closed declaration. A checked-in manifest, a version-control index, or another explicit allowlist is acceptable. An unconstrained directory walk is not.

The protocol does not mandate a checked-in `openship.json`. A project MAY use one as its implementation source of truth. Generated payload files that describe the snapshot MAY be excluded from the snapshot to avoid self-reference.

Regardless of the declaration, a producer MUST refuse secret-shaped paths such as private environment files, credentials, private keys, dependency caches, and version-control internals.

## File and archive retrieval

A File endpoint MUST compare the requested path against the Manifest as an exact string. It MUST NOT resolve an arbitrary URL path against a filesystem. Unknown paths return `404`.

An Archive MUST contain exactly the Manifest path set. It SHOULD preserve declared symlinks and file modes where practical. Archive bytes do not affect the Sources digest.

## Consumer verification

A conforming consumer:

1. Fetches discovery, Manifest, and Bundle.
2. Validates both JSON documents.
3. Confirms sorted unique safe paths and exact Manifest/Bundle key equality.
4. Decodes every file and verifies byte size and SHA-256.
5. Recomputes and compares the snapshot digest.
6. Writes only verified paths beneath a chosen empty destination.

A consumer MUST finish validation before executing any retrieved code.

## Security

Serving Sources makes every included byte public. Producers MUST NOT publish secrets, environment values, signing keys, private deployment configuration, or data exports. File selection is the primary security boundary; filters and pattern scans are defense in depth.

