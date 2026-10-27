# SmartERP Backend — Security Policy & Vulnerability Disclosure

## 1. Overview & Security Philosophy

SmartERP Backend provides the multi-tenant core services, REST APIs, business workflow engines, authentication gateway, and database persistence layer for the SmartERP platform. Because the backend manages critical enterprise data — including payroll, financial invoices, proprietary CNC manufacturing jobs, employee attendance records, and persistent AI knowledge embeddings — security and strict tenant isolation are non-negotiable architectural mandates.

Our defense model is built on:
- **Strict Server-Side Authorization:** Every mutation and data query is authenticated and authorized; client-side state is never trusted.
- **Database-Level Row-Level Security (RLS):** All multi-tenant tables enforce forced RLS policies scoped by `app.current_company_id`, `app.current_user_id`, and `app.current_role`.
- **Append-Only Auditing:** Financial transactions, security incidents, and production dispatches are maintained in tamper-evident, append-only ledgers.
- **Fail-Closed Gatekeepers:** Unrecognized roles, unverified signatures, or missing tenant contexts fail closed immediately with HTTP 401/403.

---

## 2. Supported Versions

Security updates are actively maintained on the designated release and staging branches:

| Branch / Release Target | Status | Supported Environments |
| :--- | :--- | :--- |
| `launch-hardening` | :white_check_mark: Active Maintenance | Staging & Production Targets |
| `main` | :white_check_mark: Supported | Production Releases (`api.prozync.in`) |
| Feature Branches (`feature/*`) | :x: Untracked | Development Only |

---

## 3. Reporting a Vulnerability

We encourage the responsible disclosure of security issues by researchers, team members, and customers.

> [!IMPORTANT]
> **Never open a public GitHub issue or pull request for security vulnerabilities.**

### Contact Channels
- **Primary Security Email:** `security@prozync.in`
- **PGP Encryption:** Available upon request for sensitive attachments and exploit PoCs.
- **GitHub Security Advisories:** Use the private disclosure feature under **Security > Advisories** if repository permissions allow.

### What to Include
1. **Vulnerability Type:** (e.g., Tenant Isolation Bypass, SQL Injection, Broken Object Level Authorization / BOLA, Privilege Escalation, Cryptographic Flaw).
2. **Endpoint & Method:** (e.g., `POST /api/production/orders/:id/dispatch`, `GET /api/owner/payroll`).
3. **Reproduction Steps:** Minimal, reproducible payload and curl/HTTP request script.
4. **Impact:** Clear description of how the vulnerability impacts data confidentiality, integrity, or tenant boundaries.

---

## 4. Response Timeline & SLA

- **Initial Acknowledgment:** Within **24–48 hours** of receipt.
- **Triage & Risk Scoring:** Within **3 business days** using CVSS v3.1 standards.
- **Remediation & Patching:**
  - *Critical / High Severity (e.g., Cross-tenant data exfiltration, RCE):* Hotfix within **72 hours**.
  - *Medium Severity:* Addressed within **14 business days**.
  - *Low Severity:* Scheduled in the next regular sprint release.
- **Public Disclosure:** Coordinated release after patch deployment and a 90-day grace period.

---

## 5. Security Scope & Priority Focus Areas

### High-Priority In-Scope Areas
- **Multi-Tenant Boundary Enforcement:** Cross-tenant reads, writes, or index traversal across `company_id` boundaries.
- **Database Row-Level Security (RLS):** Bypass of PostgreSQL RLS policies on `ai_documents`, `ai_document_chunks`, `security_events`, or core business tables.
- **Role-Based Access Control (RBAC):** Escalation from `customer` or `employee` to `owner`, `admin`, or `super_admin`.
- **Payment & Financial Idempotency:** Signature tampering (Razorpay), double-spend attacks, or invoice payment race conditions.
- **Authentication & Credential Security:** JWT forgery, refresh token theft, bcrypt implementation flaws, or OTP bypass.
- **AI / RAG Security:** Prompt injection leading to ERP tool execution, unauthorized document retrieval across tenants, or citation forgery.

### Out-of-Scope
- Distributed Denial of Service (DDoS) against cloud edge proxies (Cloudflare / Render).
- Brute-force attacks against rate-limited endpoints.
- Self-XSS or attacks requiring complete physical control of the database server.
- Theoretical issues without demonstrable security impact.

---

## 6. Safe Harbor Agreement

We will not initiate legal action against researchers who:
- Comply with this disclosure policy and give us reasonable time to resolve vulnerabilities before disclosing them.
- Avoid accessing, modifying, or destroying another tenant's production business records.
- Act in good faith to protect user privacy and system stability.
