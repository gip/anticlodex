# OpenShip v1

Status: Draft v1  
Protocol version: `1.0`

OpenShip is a public interface between a running project and the people or agents that want to understand, reproduce, or improve it. It has three capabilities:

1. **Sources** publishes an integrity-checked source snapshot.
2. **Changes** accepts a patch against a Sources digest and produces an isolated candidate origin.
3. **Systems** publishes a self-contained JSON description of source, architecture, infrastructure, and optional agent context.

Sources is the foundation. Changes depends on Sources. Systems embeds a complete Sources snapshot but does not require Changes.

The key words MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY are normative.

## Design goals

- Start from an origin, not from a repository provider.
- Use plain HTTP and JSON that small clients can implement.
- Make source identity independently verifiable.
- Keep public reading separate from permission to change or deploy.
- Let simple projects stop at Sources while advanced projects add Systems.

OpenShip does not prove who owns an origin or authored a source tree. A digest proves that two snapshots contain the same bytes. Identity and signed provenance may be layered on separately.

## Common envelope

Every OpenShip JSON document MUST contain:

```json
{
  "openship": "1.0",
  "capability": "discovery"
}
```

`capability` is one of `discovery`, `sources`, `changes`, or `systems`. A Changes error or status document remains capability `changes`.

Within major version 1, producers MAY add members without changing existing meanings. Consumers MUST ignore unknown members they do not need and SHOULD preserve them when transforming a document.

## Public discovery

An OpenShip origin MUST serve:

```text
GET /.well-known/openship.json
```

The response MUST be unauthenticated JSON, MUST allow cross-origin reads with `Access-Control-Allow-Origin: *`, and MUST contain absolute HTTPS URLs outside local development.

```json
{
  "openship": "1.0",
  "capability": "discovery",
  "project": {
    "name": "Example",
    "description": "A short description of the running project."
  },
  "skill": "https://example.com/openship/file/skills/openship/SKILL.md",
  "capabilities": {
    "sources": {
      "manifest": "https://example.com/openship/manifest.json",
      "bundle": "https://example.com/openship/bundle.json",
      "file": "https://example.com/openship/file/{path}",
      "archive": "https://example.com/openship/source.tar.gz",
      "instructions": "https://example.com/openship/agent.txt"
    },
    "changes": {
      "policy": "https://example.com/openship/policy.json",
      "submit": "https://example.com/openship/changes",
      "status": "https://example.com/openship/changes/{changeId}"
    },
    "systems": {
      "document": "https://example.com/openship/system.json"
    }
  }
}
```

Requirements:

- `project`, `capabilities`, and `capabilities.sources` are REQUIRED.
- `project.name` and `project.description` are REQUIRED.
- `sources.manifest` and `sources.bundle` are REQUIRED.
- `changes`, `systems`, and `skill` are OPTIONAL and MUST be omitted when unavailable.
- Changes MUST NOT be advertised without Sources.
- `file` and `status` are URI templates with exactly the named expansion.
- A project implementing Sources and Changes but not Systems simply omits `capabilities.systems`.

See [schemas/discovery.schema.json](schemas/discovery.schema.json).

## Access and transport

Discovery, Sources, and Systems reads MUST NOT require cookies, credentials, custom headers, or query parameters. Changes writes MAY require authorization or payment disclosed by the Changes policy.

JSON responses MUST use UTF-8. Public reads SHOULD support transport compression. A producer MAY offer additional representations, but the advertised JSON representation remains normative.

## Caching

Stable current-origin URLs can change after a deployment. They MUST be revalidatable and MUST NOT be marked `immutable`. A suitable default is:

```text
Cache-Control: public, max-age=0, must-revalidate
```

Content-addressed URLs and candidate origins whose hostname is derived from the resulting Sources digest MAY use:

```text
Cache-Control: public, max-age=31536000, immutable
```

Changes status responses change over time and MUST use `Cache-Control: no-store`.

## Capability documents

- Read [openship-sources.md](openship-sources.md) for source snapshots and integrity.
- Read [openship-changes.md](openship-changes.md) for candidate changes and isolation.
- Read [openship-systems.md](openship-systems.md) for the self-contained systems model.

## Conformance

A producer is conformant for a capability when its advertised documents pass the relevant schema and every cross-document invariant in that capability specification. Advertising one capability does not claim conformance for another.

A consumer SHOULD report a precise path and invariant when rejecting a payload. It MUST reject unsupported major versions rather than silently interpreting them as v1.

