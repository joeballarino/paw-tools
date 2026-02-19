# PAW API Contract

## 1) Overview

### Purpose
This document defines the API contract between embedded tool frontends (`tool-shell.js`) and the private Cloudflare Worker (`paw-api`).

### Non-goals
- This is not a product manual.
- This is not internal worker implementation documentation.

## 2) Environment + Base URL

- `__apiEndpoint` is the base URL used by `tool-shell.js` for API requests.
- Embedded tools call `paw-api` only via HTTPS `fetch` from within the embedded tool iframe.

## 3) Authentication (high-level)

- Requests are made in the context of a Circle-authenticated user.
- The frontend does not store long-term secrets.
- Authentication is represented generically as **session/auth context provided by Circle + paw-api**.

## 4) Standard Request/Response Conventions

### Content type
- Request and response bodies use JSON (`application/json`).
- Requests include the embed environment’s auth/session context.

### Response envelope
- Success:

```json
{ "ok": true, "data": { } }
```

- Error:

```json
{ "ok": false, "error": { "code": "SOME_CODE", "message": "Human-readable message", "details": { } } }
```

### Common error codes
- `UNAUTHORIZED`
- `FORBIDDEN`
- `NOT_FOUND`
- `VALIDATION_ERROR`
- `RATE_LIMITED`
- `INTERNAL`

### Single-record response shape
- Single-record endpoints return `{ "ok": true, "data": { "work": { ... } } }`.

## 5) My Works: Data Model

### Buckets
Buckets are exactly:
- `brand_assets`
- `listings`
- `transactions`

### Work record fields
- `work_id` (string)
- `bucket` (enum: `brand_assets | listings | transactions`)
- `label` (string)
- `created_at` (ISO-8601 string)
- `updated_at` (ISO-8601 string)
- `payload` (opaque JSON object, stored and returned as-is; tools define its structure)
- Optional:
  - `metadata` (object)
  - `preview` (string)
  - `tags` (string[])

### Save behavior
- Nothing is saved automatically.
- Saves are explicit frontend actions.

## 6) My Works: Endpoints (contract)

Endpoints are exposed under the canonical path `/myworks`.

### GET `/myworks?bucket=...&q=...&limit=25&cursor=...`
Lists works for the current user.

Request query parameters:
- `bucket` (optional enum)
- `q` (optional search string)
- `limit` (optional number, default 25)
- `cursor` (optional pagination cursor)

Success response shape:

```json
{
  "ok": true,
  "data": {
    "list": [
      {
        "work_id": "string",
        "bucket": "brand_assets",
        "label": "string",
        "created_at": "2026-01-01T00:00:00Z",
        "updated_at": "2026-01-01T00:00:00Z",
        "metadata": {},
        "preview": "string",
        "tags": ["string"]
      }
    ],
    "next_cursor": "opaque-cursor-or-null"
  }
}
```

### GET `/myworks/{work_id}`
Returns a single work record and any stored payload.

Success response shape:

```json
{
  "ok": true,
  "data": {
    "work": {
      "work_id": "string",
      "bucket": "brand_assets",
      "label": "string",
      "created_at": "2026-01-01T00:00:00Z",
      "updated_at": "2026-01-01T00:00:00Z",
      "metadata": {},
      "preview": "string",
      "tags": ["string"],
      "payload": {}
    }
  }
}
```

### POST `/myworks`
Creates a new work record.

Request body shape:

```json
{
  "bucket": "brand_assets",
  "label": "My Work",
  "payload": {},
  "metadata": {}
}
```

- `bucket`, `label`, and `payload` are required.
- `metadata` is optional.

### PATCH `/myworks/{work_id}`
Updates one or more of: `label`, `metadata`, `payload`.

Request body shape:

```json
{
  "label": "Updated name",
  "metadata": {},
  "payload": {}
}
```

### Optional duplication endpoint
- Optional endpoint: `POST /myworks/{work_id}/duplicate`.
- Equivalent behavior can be implemented as `save_as_new` via `POST /myworks` with copied payload.

## 7) Save Intents Mapping (from tool-shell events)

Frontend save intents map to API actions:
- `intent=create` -> `POST /myworks`
- `intent=save_updates` -> `PATCH /myworks/{work_id}`
- `intent=save_as_new` -> `POST /myworks` (new work with copied payload)

Existing frontend event name:
- `paw:works:save_current_output`

Expected event `detail` payload:

```json
{
  "active_work": {},
  "intent": "create | save_updates | save_as_new"
}
```

## 8) Versioning + Backward Compatibility

- `contract_version: "1.0"`
- `paw-api` should remain backward compatible for at least one minor version.
- Frontends should tolerate unknown fields in responses.

## 9) Notes for Frontend Implementers

- Pagination default is 25 items; provide a “Load more” interaction.
- Default sorting is `updated_at` descending.
- Tools produce “current output” payloads; `paw-api` stores these payloads under the work record.
