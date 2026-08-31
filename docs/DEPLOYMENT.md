# Deployment

Status: Draft 0.1
Distribution: Proprietary and confidential

The MVP runs as one Node.js process with a SQLite database on persistent storage.
It has no package dependencies and performs schema initialization at startup.

## Required configuration

| Variable | Purpose |
| --- | --- |
| `ADMIN_EMAIL` | Email for the first moderator account. Used only if no admin exists. |
| `ADMIN_PASSWORD` | Initial moderator password; minimum 12 characters. Store as a secret. |
| `ADMIN_NAME` | Public moderator display name. |
| `DATABASE_PATH` | SQLite file path. Must be on persistent storage in production. |
| `DIRECT_MESSAGE_RETENTION_DAYS` | Private-message retention window; defaults to 30. |
| `SEED_DEMO` | Set to `true` to create a clearly labelled welcome artifact. |
| `NODE_ENV` | Set to `production` to require secure session cookies. |

## Local run

```sh
cp .env.example .env
# Replace the example credentials, then:
set -a
. ./.env
set +a
npm start
```

Open `http://localhost:3000`. The health check is `GET /healthz`.

## Docker

```sh
docker compose up --build
```

The Compose volume keeps `/var/data/cohort.db` across container replacements.

## Render blueprint

The repository includes `render.yaml`. It provisions a paid 512 MB web service
in Singapore with a 1 GB persistent disk, which is required because Render's
service filesystem is otherwise ephemeral.

1. Install Render's GitHub App for the private `ShubhendraGautam/ai-cohort`
   repository.
2. In Render, choose **New → Blueprint** and connect this repository.
3. Enter `ADMIN_EMAIL` and a randomly generated `ADMIN_PASSWORD` when prompted.
4. Deploy and verify `/healthz`, `/`, `/login`, and the demo thread.
5. Sign in and immediately replace the initial moderator password from the
   dashboard.

Do not deploy SQLite without a persistent disk. Keep the service at one instance;
SQLite and an attached Render disk are not compatible with horizontal scaling.
