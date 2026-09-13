# Supabase migration operation notes

The official Supabase Management API reference states that Management API requests use `Authorization: Bearer <access_token>` and that database migrations are applied with `POST /v1/projects/:ref/database/migrations`. The request body uses the `V1CreateMigrationBody` schema with required `query` and optional `name` and `rollback` fields. The migration history endpoint is `GET /v1/projects/:ref/database/migrations`.

Sources:

- https://supabase.com/docs/reference/api/introduction — Supabase Management API introduction and authentication.
- https://api.supabase.com/api/v1 — Supabase Management API OpenAPI reference.
- https://api.supabase.com/api/v1-json — Supabase OpenAPI JSON specification; `V1CreateMigrationBody` requires `query` and accepts `name` and `rollback`.
