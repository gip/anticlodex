# OpenShip 1.0 agent workspace

Read `control/skills/openship/SKILL.md` before making changes.

- `project/` is the exact verified source tree. Make all source edits there.
- `control/system.json` is the canonical Systems document. Make architecture and context edits there.
- `control/skills/openship/` is synchronized from `@openshipdev/protocol`; do not edit it.
- Do not create architecture merely because source exists. For a Sources-only import, architecture analysis happens only when the user explicitly asks for it.
- Do not copy source bytes into `control/system.json`. Code artifacts reference `sourcePaths`.

The server rebuilds Sources from `project/`, replaces the embedded source in `control/system.json`, validates the complete OpenShip 1.0 document, and applies source and system edits atomically.
