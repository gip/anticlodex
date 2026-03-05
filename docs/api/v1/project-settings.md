# Project settings API (v1)

Project settings endpoints are scoped to `/:handle/:projectName` and require Bearer auth.

## Authorization model

- Read settings (`GET .../collaborators`): any accessible project member/viewer.
- Mutations: owner only, except project description (`PATCH .../description`) which allows Owner or Editor.

Unauthorized mutation attempts return `403 Forbidden`.

## Endpoints

### Get settings payload

- `GET /v1/projects/:handle/:projectName/collaborators`

Response:

```json
{
  "accessRole": "Owner",
  "visibility": "private",
  "projectRoles": ["All", "Frontend", "Backend"],
  "concerns": [
    { "name": "Reliability", "position": 0, "isBaseline": true, "scope": null }
  ],
  "collaborators": [
    {
      "handle": "alice",
      "name": "Alice",
      "picture": null,
      "role": "Owner",
      "projectRoles": ["All"]
    }
  ]
}
```

### Update visibility

- `PATCH /v1/projects/:handle/:projectName/visibility`
- Body: `{ "visibility": "public" | "private" }`

### Update project description

- `PATCH /v1/projects/:handle/:projectName/description`
- Body: `{ "description": string | null }`
- Access: Owner or Editor
- Behavior:
  - Missing `description` in request body returns `400`.
  - String descriptions are trimmed.
  - Empty trimmed descriptions are stored as `null`.

### Archive project

- `POST /v1/projects/:handle/:projectName/archive`
- Response: `204 No Content`

### Add collaborator

- `POST /v1/projects/:handle/:projectName/collaborators`
- Body:

```json
{
  "handle": "bob",
  "role": "Editor",
  "projectRoles": ["Frontend"]
}
```

### Remove collaborator

- `DELETE /v1/projects/:handle/:projectName/collaborators/:collaboratorHandle`

### Update collaborator project roles

- `PUT /v1/projects/:handle/:projectName/collaborators/:collaboratorHandle/roles`
- Body:

```json
{
  "projectRoles": ["Backend", "Infra"]
}
```

### Add role

- `POST /v1/projects/:handle/:projectName/roles`
- Body: `{ "name": "Infra" }`

### Delete role

- `DELETE /v1/projects/:handle/:projectName/roles/:roleName`

### Add concern

- `POST /v1/projects/:handle/:projectName/concerns`
- Body: `{ "name": "Cost" }`

### Delete concern

- `DELETE /v1/projects/:handle/:projectName/concerns/:concernName`

## Validation and safeguards

- Owner cannot be added as collaborator.
- `projectRoles` must contain at least one valid role.
- Role deletion is blocked while members are assigned.
- Concern deletion is blocked while linked to matrix refs or artifacts.
- Duplicate role/concern/collaborator inserts return `409`.
