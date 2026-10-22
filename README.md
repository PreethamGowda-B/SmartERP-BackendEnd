# SmartERP Backend

This folder contains the Express backend for SmartERP.

## Setup (PowerShell)

1. Update `.env` with your database credentials and a JWT secret.

2. Install dependencies:

```powershell
cd c:\Users\mrpre\Desktop\backend
npm install
```

3. Create the database tables (requires `psql` in PATH):

```powershell
psql -h localhost -U <DB_USER> -d <DB_NAME> -f c:\Users\mrpre\Desktop\backend\schema.sql
```

4. (optional) Create an admin user using environment variables:

```powershell
$env:ADMIN_EMAIL='admin@example.com'; $env:ADMIN_PASSWORD='admin123'; npm run create-admin
```

5. Start the server:

```powershell
npm run dev
# or
npm start
```

## Endpoints (examples)

- POST /api/auth/login { email, password }
- GET /api/users/me (requires Authorization header)
- POST /api/activities { action }
- GET /api/activities
- POST /api/jobs
- GET /api/jobs

### Employees API

The `/api/employees` endpoints require a valid authenticated token and company context. Employee creation is limited to owner, admin, or HR roles and is subject to the current subscription employee limit. The application does not implement the previously documented `DEV_ALLOW_UNAUTH_USERS` bypass; do not add an unauthenticated employee mode for local testing.

## Testing with curl (PowerShell)

Login and store token:

```powershell
$resp = curl -Method Post -Uri http://localhost:4000/api/auth/login -Body (@{email='admin@example.com'; password='admin123'} | ConvertTo-Json) -ContentType 'application/json' | ConvertFrom-Json
$token = $resp.token
```

Use token to call protected endpoint:

```powershell
curl -Headers @{ Authorization = "Bearer $token" } -Uri http://localhost:4000/api/users/me
```
