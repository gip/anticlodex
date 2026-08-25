# OpenShip Changes v1

OpenShip Changes lets a project accept a replacement patch against a known Sources digest and, after validation, expose the resulting code at an isolated candidate origin.

Changes depends on [OpenShip Sources](openship-sources.md). It does not promote code to production.

## Discovery and methods

Discovery advertises:

- `policy`: public `GET` describing server-specific rules.
- `submit`: `POST` accepting a JSON change.
- `status`: public `GET` URI template containing `{changeId}`.

Policy and status reads follow OpenShip's public CORS rules. Submission MUST support CORS preflight for JSON and any advertised authorization or payment headers.

## Policy

```json
{
  "openship": "1.0",
  "capability": "changes",
  "writable": ["app/**", "components/**", "public/**"],
  "protected": ["app/api/**", "skills/openship/**"],
  "limits": {
    "filesPerChange": 40,
    "bytesPerFile": 262144,
    "bytesPerChange": 1048576
  },
  "contentRules": [
    { "id": "dynamic-eval", "rule": "Dynamic evaluation", "message": "Use static imports." }
  ],
  "document": "https://example.com/openship/file/skills/openship/references/openship-changes.md"
}
```

`writable` is an allowlist. `protected` takes precedence. Patterns use one shared grammar: an exact path matches itself; a value ending in `/**` matches that directory and all descendants. No other wildcard syntax is defined in v1.

A producer MAY add authorization, payment, media, build, review, or deployment policy. It MUST NOT describe a filter as a security boundary.

See [schemas/changes-policy.schema.json](schemas/changes-policy.schema.json).

## Submission

```json
{
  "openship": "1.0",
  "capability": "changes",
  "base": "sha256:1c413f...",
  "title": "Improve the project page",
  "intent": "Explain what the change does and why.",
  "files": {
    "app/page.tsx": { "encoding": "utf-8", "content": "..." },
    "public/old-logo.png": null
  }
}
```

`base` MUST name a Sources digest the server currently accepts. A file value replaces or creates that path. `null` deletes it. An absent path is unchanged. Paths and encodings follow Sources.

The producer MUST validate the envelope, base, paths, sizes, content rules, and resulting file tree before charging or queueing expensive work. A stale base returns `409`. Deterministic policy violations return `422` with precise violations.

See [schemas/changes-submission.schema.json](schemas/changes-submission.schema.json).

## Accepted response

```json
{
  "openship": "1.0",
  "capability": "changes",
  "changeId": "5d7621f4-7ad5-49f6-8168-da99620ff1cf",
  "base": "sha256:1c413f...",
  "digest": "sha256:9f2c1a...",
  "status": "pending",
  "phase": "queued",
  "candidateOrigin": "https://9f2c1a7b3e04.example-builds.net",
  "statusUrl": "https://example.com/openship/changes/5d7621f4-7ad5-49f6-8168-da99620ff1cf",
  "buildId": "9f2c1a7b3e04"
}
```

The server computes the resulting Manifest and digest before acceptance. `candidateOrigin` MUST be returned for an accepted change, even if it is not live yet. `buildId` and `phase` are optional provider metadata.

The same resulting digest MAY return an existing record with `200`. A newly queued change returns `202`.

See [schemas/changes-accepted.schema.json](schemas/changes-accepted.schema.json).

## Status

The normative lifecycle is:

| Status | Meaning |
|---|---|
| `pending` | Accepted but processing has not started. |
| `processing` | Validation, building, review, or publication is in progress. |
| `ready` | Candidate origin is live and verified. |
| `rejected` | Policy or review rejected the candidate. |
| `failed` | Infrastructure failed to produce a candidate. |

An implementation maps internal states such as `queued`, `building`, `reviewing`, and `deployed` into the core status and MAY expose the internal value as `phase`.

Before reporting `ready`, the producer MUST fetch or otherwise verify the candidate origin's advertised Sources Manifest and confirm its digest equals the accepted resulting digest.

Status responses MUST use `Cache-Control: no-store`. See [schemas/changes-status.schema.json](schemas/changes-status.schema.json).

## Error responses

Errors contain `openship`, `capability`, `error`, and a human-readable `message`. Relevant status codes include:

- `400` malformed JSON or envelope.
- `401` or `403` authorization failure.
- `402` advertised payment required.
- `409` stale or unknown base digest.
- `413` transport or decoded size limit.
- `422` deterministic policy violations, with `violations`.
- `501` Changes is installed but disabled on this deployment.

Synchronous stale-base and policy-violation responses follow
[schemas/changes-violation.schema.json](schemas/changes-violation.schema.json).

## Candidate isolation

A candidate executes code supplied by an untrusted author. Therefore:

- Its origin MUST use a different registrable domain from production, not merely a subdomain.
- Its build and runtime MUST contain no production secret or production credential.
- Submitted code MUST never receive a deployment credential.
- Build execution SHOULD have no network after dependency installation and SHOULD use explicit resource limits.
- Production promotion is a separate maintainer decision outside OpenShip.

Path filters, content scans, tests, and model review are useful filters. Isolation is the security boundary.

## Identity and lineage

The resulting Sources digest is the candidate's normative identity. A hostname or `buildId` derived from a digest is a convenience that clients verify by retrieving Sources from the candidate origin. Candidate Sources SHOULD include optional `parent` metadata naming the base digest.
