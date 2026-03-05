# AGENTS

## Agent bootstrap

- At the start of a run, read `AGENTS.md` first.
- Then read `./skills/openship-specs-v1/SKILL.md`.
- Then read the system description in `./openship`.

## OpenShip files in this bundle

- `./openship.yaml`: root manifest (`specVersion`, `systemNodeId`, concern set).
- `./edges/edges.yaml`: runtime graph edges between nodes.
- `./nodes/<nodeId>/node.yaml`: node definitions (`id`, `kind`, `name`, `parentId`, `metadata`), concern matrix, artifact references, and prompt refs on the root node when present.
- `./inputs/documents/*.md`: content-addressed shared documents.
- `./inputs/skills/*.md`: content-addressed shared skills.
- `./nodes/<nodeId>/artifacts/code/*`: code artifacts for a node.
- `./skills/openship-specs-v1/SKILL.md`: OpenShip specification instructions (authoritative).
- `./SKILLS.md`: legacy OpenShip specification artifact copy (kept for compatibility).

## Node ID convention (typed schemes)

- In typed-id systems, node IDs follow `<type>.<key>`:
  - `s.root` for `Root`
  - `h.<key>` for `Host`
  - `c.<key>` for `Container`
  - `p.<key>` for `Process`
  - `l.<key>` for `Library`
- `<key>` is kebab-case (`[a-z0-9]+(?:-[a-z0-9]+)*`) and is stored in `metadata.openshipKey`.
- For typed-id systems, node kind changes are not allowed once a node exists (ID/kind pairing is immutable).

## How to change the system description and topology

- Treat `./openship` as the authoritative in-place edit surface for system topology.
- Update system description in `./openship.yaml` first when system-level metadata or concern framing changes.
- Keep the relationship:
  - System description (`openship.yaml`) defines root/system-level intent.
  - `nodes/<nodeId>/node.yaml` defines actual nodes.
  - `edges/edges.yaml` defines connectivity rules.

## How to modify topology safely

- Add a node:
  - Create `nodes/<newNodeId>/node.yaml`.
  - Set a unique `id`.
  - Set valid `kind`, `name`, optional `parentId`, and consistent `metadata`.
  - Every node metadata MUST include:
    - `ownership: first_party | third_party`
    - `boundary: internal | external`
  - For `Host` nodes, names MUST start with:
    - `First-Party Host` when `ownership: first_party`
    - `Third-Party Service Host` or `External Service Host` when `ownership: third_party`
  - Add at least one valid `matrix` concern entry.
  - Add connecting edge entries in `edges/edges.yaml` (or leave disconnected, if intended for draft).
- Move a node:
  - Edit only the existing `nodes/<nodeId>/node.yaml`.
  - Update `parentId` and any affected metadata.
  - Keep `id`, `kind`, `name`, and matrix concern names/refs valid and consistent.
- Remove a node:
  - Remove `nodes/<nodeId>/node.yaml`.
  - Remove all `edges/edges.yaml` rows with `fromNodeId` or `toNodeId` equal to that node id.
  - Remove references to the node's artifacts if still tracked in bundle state.
- Add or edit a document:
  - Add a new document by creating `./inputs/documents/<newHash>.md` with frontmatter plus body text, then update all `matrix.documentRefs` entries in affected `nodes/<nodeId>/node.yaml` from old hash to `newHash`.
  - Edit an existing document only for non-content changes that keep the same hash; if the document content changes, treat it as a replacement and perform a hash-refresh flow as above.
- Remove a document:
  - Delete only the selected `./inputs/documents/<hash>.md` file.
  - Remove every `documentRefs` occurrence of `<hash>` from all node matrices before saving.
- Add or edit a skill document:
  - Same pattern as documents, but under `./inputs/skills/*.md` and `matrix.skillRefs`.
- Rewire links:
  - Edit only `edges/edges.yaml`.
  - Preserve edge constraints from `./skills/openship-specs-v1/SKILL.md` (types, direction, and endpoint constraints).
- For system metadata edits:
  - Update `openship.yaml` and any dependent `nodes/*/node.yaml` / `edges/edges.yaml` changes in the same change set.
- Do not remove shared inputs unless explicitly removing them from matrix usage:
  - `./inputs/documents/*.md` and `./inputs/skills/*.md` are hash-addressed and can be referenced from multiple places.
  - Remove these files only when a revision is intentionally replaced.
- For system-level prompts, keep `Prompt` references constrained to the root node via the hidden concern `__system_prompt__`.

## Validation checks before responding

- Confirm every changed topology file remains valid YAML.
- Confirm `openship.yaml`, `edges/edges.yaml`, and affected `nodes/*/node.yaml` are updated together when topology changes.
- Confirm every changed node defines `metadata.ownership` and `metadata.boundary` with valid values.
- Confirm every changed `Host` name follows ownership-based naming conventions.
- Confirm matrix references still use valid hashes and concern names.
- Mention which topology files changed and why before finishing.
