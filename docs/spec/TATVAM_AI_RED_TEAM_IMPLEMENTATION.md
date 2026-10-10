# Tatvam AI Red Team — Implementation Specification

**Version:** 1.0 — implementation blueprint  
**Decisions:** rented NVIDIA B200-class GPU; **single-host deployment for MVP**; **Hybrid Mode first**; scope enforcement and human approval **mandatory**.  
**Audience:** full-stack, AI/ML, platform, and security engineers.  
**Purpose:** authorized security assessments, security code review, controlled verification, and evidence-backed reporting.

> **Non-negotiable:** A user's chat instruction, an LLM output, and an MCP server response are never authorization. Only a separately recorded, reviewed engagement scope grants actions. Do not run intrusive actions without an explicit, per-action human approval. The MVP provides no autonomous exploitation, credential attacks, persistence, lateral movement, or exfiltration capability.

---

## 1. Product and acceptance goals

### 1.1 Product modes

- **Hybrid (MVP default):** AI proposes a bounded plan and can perform explicitly permitted passive/low-impact actions on allowlisted assets. Any medium/high-risk activity pauses for human review; some categories remain forbidden in MVP regardless of approval.
- **Interactive (later):** human requests and approves individual proposed tool calls, with the same server-side policy checks.
- **Autonomous (later):** unattended execution of signed, pre-approved *non-destructive* playbooks; cannot auto-approve gated actions.

### 1.2 MVP user journeys

1. Security lead creates an engagement, uploads or records scope authorization, and identifies eligible assets and test window.
2. Reviewer approves scope. Without approved, valid scope **no target-contacting tool** may run.
3. Analyst starts a Hybrid run: objective, allowed assets, rate/concurrency caps, maximum duration and budget.
4. Supervisor proposes a plan; policy service validates each tool request independently.
5. Approved low-impact checks run in a restricted worker; approval-required operations enter queue and remain blocked.
6. Analyst approves/rejects a specific **immutable tool payload**, with expiry and reason. Execution revalidates authorization and constraints.
7. Agent correlates results and generates draft findings; analyst reviews and exports report.
8. All scope versions, denials, tool invocations, approvals, model outputs, and evidence hashes are auditable.

### 1.3 Safety invariants (must be automated tests)

- Default deny: missing, expired, unreviewed, or revoked scope blocks execution.
- Target allowlist is checked on **resolved destination IPs, hostnames, redirects and proxy destinations**, not just a user-supplied URL string.
- Every outbound target-contacting operation gets a short-lived server-signed execution capability bound to run, scope version, target, action, parameters, worker and expiry.
- Approval is issued to a SHA-256 hash of canonical **fully resolved parameters**; modifications invalidate it.
- No tool gateway endpoint accepts arbitrary shell strings, scripts, file paths, URLs or scanner flags from LLM as executable input.
- Scope changes and revocation invalidate pending approvals/capabilities and terminate active work.
- Replays, duplicate deliveries and retries cannot bypass approval or produce duplicate intrusive executions.
- Every job has rate limits, concurrency ceilings, execution timeouts, network isolation and emergency stop.
- Any tool-result content is untrusted; prompt injection within scan output cannot change policy or invoke tools.
- Exports redact credentials, secrets, personal data and sensitive HTTP bodies by default.

### 1.4 Deliberately out of scope for MVP

Autonomous exploitation, broad internet scanning, credential brute forcing, evasion, malware deployment, persistence, lateral movement, unrestricted packet crafting, shell on third-party hosts, destructive testing, and data exfiltration. Build an approval model and isolated labs first; adding new capabilities requires a formal threat model, independent review, legal authorization, and new tests.

---

## 2. Architecture: one rented GPU host

```mermaid
flowchart TB
  U[Browser: Next.js dashboard] --> P[Private reverse proxy: TLS + OIDC]
  P --> A[FastAPI application]
  A --> DB[(PostgreSQL + pgvector)]
  A --> R[(Redis queue)]
  A --> O[(MinIO artifacts)]
  A --> G[LangGraph supervisor + checkpoints]
  G --> L[LiteLLM or direct client]
  L --> V[vLLM on B200 GPU]
  G --> T[Typed Tool Gateway]
  T --> Q[Policy Decision Point]
  Q --> DB
  T --> W[Ephemeral restricted worker]
  W --> FW[Enforced target egress proxy/firewall]
  FW --> S[Approved staging/lab assets only]
  W --> O
  A --> OBS[OpenTelemetry + Prometheus/Loki]
```

### 2.1 Single-host caveat

Single-host means convenience, **not** genuine isolation between management plane and potentially hostile tool execution. Containers share a kernel; rented GPU hosts can be reclaimed, reimaged, or suspended. **Strong recommendation:** even during an all-in-one MVP, run untrusted analyzers in a microVM (Firecracker/Kata, where supported), or in a separate disposable remote worker later. If provider does not permit nested virtualization, begin with passive analysis and typed read-only checks and keep binary/malware execution disabled. A network firewall must enforce traffic rules outside the agent's control.

### 2.2 Suggested stack

| Layer | Choice | Notes |
|---|---|---|
| Web | Next.js + TypeScript + Tailwind + shadcn/ui | Server-side authenticated dashboard |
| Live updates | SSE initially; WebSocket optional | Run events and approval status |
| Backend | FastAPI + Pydantic v2 + SQLAlchemy 2 + Alembic | Python integration with agents |
| Agent state | LangGraph + PostgreSQL checkpointer | Deterministic interrupts/resume |
| Queue | Redis + Celery | Retries, scheduling, worker lifecycle |
| LLM | vLLM OpenAI-compatible endpoint | B200 driver/CUDA/model compatibility must be validated |
| Model router | LiteLLM optional | Single model can start direct |
| Memory | PostgreSQL + pgvector | Retrieval only from authorized tenant/project |
| Artifacts | MinIO S3-compatible | Versioning/encryption/retention |
| Identity | Keycloak OIDC or existing OIDC provider | MFA, roles, sessions |
| Policy | Dedicated FastAPI module initially; OPA later | **Independent deterministic rules** |
| Execution | constrained worker with typed adapters; microVM preferred | Never mount Docker socket or GPU device inside tool worker |
| Observability | OpenTelemetry, Prometheus, Grafana, Loki | Protect logs from leaking secrets |
| Reverse proxy | Caddy/Traefik | TLS; private ingress only |
| Backups | encrypted off-host PostgreSQL + artifacts | Host storage alone is not durable |

**Pin tested container image digests and dependency lockfiles in production.** Version numbers and specific model repository names change; validate latest B200 inference support and model licensing at provisioning time.

### 2.3 Capacity assumptions

- B200 advertised 192 GB VRAM is an **upper hardware specification**, not available model-memory guarantee. Validate actual device via `nvidia-smi`, driver and VRAM.
- Start with one inference process and **one or two concurrent agent runs**; tune based on actual token throughput and KV-cache demand.
- Target starter CPU/RAM: 16–32 vCPU and 64–128 GB RAM if your rented host offers it. Actual requirements depend on model loading, observability, scans, and databases.
- If GPU billed while powered on, run short-lived test sessions; preserve DB/backups off-host before stopping. Stopping a rented instance may destroy local disks depending on the provider.

---

## 3. Repository layout

```text
tatvam-redteam/
├── apps/web/                         # Next.js App Router
├── services/api/app/
│   ├── main.py
│   ├── auth/                       # OIDC JWKS, tenant scoping, RBAC
│   ├── routes/                     # REST/SSE APIs
│   ├── db/models.py
│   ├── db/migrations/               # Alembic
│   ├── policies/                    # pure, testable Policy Decision Point
│   ├── agents/                      # LangGraph states and nodes
│   ├── tools/                       # typed descriptors, adapters, gateway
│   ├── workers/                     # queue jobs and isolation adapters
│   ├── evidence/                    # hashing, sanitization, S3
│   └── reports/                     # structured exports
├── packages/contracts/             # OpenAPI-generated TS types
├── infra/
│   ├── compose.yaml
│   ├── .env.example
│   ├── vllm/                      # launch args, model config
│   ├── gateway/                   # TLS proxy, mTLS, egress ACL
│   ├── monitoring/
│   └── scripts/                    # init / backup / restore
├── tests/unit/
├── tests/integration/
├── tests/security/
├── tests/e2e/
├── tests/evaluations/
└── docs/                            # runbooks, threat model, ADRs
```

### 3.1 Team working agreement

- Every PR includes tests for successful execution **and denial paths**.
- Schema migration and OpenAPI update required for persistence/API changes.
- No privileged access, debug endpoints, hardcoded keys, or permissive CORS in reviewed code.
- Policy function cannot import LLM client. Agent engine cannot write approvals.
- Mandatory human security review on tool gateway, policy rules, execution image, networking and auth changes.

---

## 4. Roles, permissions and scope lifecycle

### 4.1 RBAC

- `org_admin`: accounts, organization settings (cannot self-approve an unverified scope).
- `engagement_owner`: draft scope and launch runs within approved scope.
- `scope_reviewer`: independently approve/revoke signed scope attestations.
- `analyst`: run permitted Hybrid workflows and request approvals.
- `action_approver`: approve a specific proposed action in a valid engagement; cannot approve own action if separation-of-duties flag is on.
- `viewer`: read sanitized findings and reports.
- `platform_operator`: operate infrastructure; separate from authorization to perform assessments.

### 4.2 Engagement lifecycle

`draft -> pending_review -> approved -> active -> paused -> completed`  
Exceptional transitions: `pending_review -> rejected`; any nonterminal state `-> revoked`. Only approved/active engagements with current window and matching scope version can execute target-contacting tools.

### 4.3 Scope document

The source-of-truth scope is a structured, reviewed artifact:

```json
{
  "engagement_id": "uuid",
  "version": 3,
  "authorization_reference": "signed-work-order-2026-10",
  "authorized_by": "customer-representative-id",
  "approved_asset_ids": ["uuid-of-staging-site"],
  "allowed_dns_suffixes": ["staging.example.org"],
  "allowed_cidrs": ["192.0.2.0/28"],
  "allowed_protocols": ["https"],
  "allowed_ports": [443],
  "allowed_action_types": ["passive_http_metadata", "safe_service_inventory"],
  "blocked_action_types": ["credential_attack", "destructive_change", "exfiltration"],
  "valid_from": "2026-10-15T08:00:00Z",
  "valid_until": "2026-10-15T13:00:00Z",
  "max_rps": 1,
  "max_concurrent_checks": 2,
  "reviewer_id": "uuid",
  "document_sha256": "lowercase-hex-sha256"
}
```

Allowlists must be validated against the customer's signed asset inventory. DNS suffix matching must respect dot boundaries; wildcard domains and DNS rebinding are high-risk. Re-resolve immediately before each network connection, enforce the resulting IP against policy, and forbid alternate proxies and redirects outside scope. For sensitive environments prefer fixed approved IP mapping and destination-aware egress proxy rules.

---

## 5. PostgreSQL schema (migration-ready starting point)

Below is a **core DDL**; add Alembic migrations and generated ORM models. PostgreSQL 16+ recommended, subject to provider support. UUIDs are generated using `gen_random_uuid()`; application should enforce tenant-scoped access, and PostgreSQL row-level security is recommended for defense-in-depth.

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TYPE engagement_status AS ENUM
 ('draft','pending_review','approved','active','paused','completed','rejected','revoked');
CREATE TYPE run_status AS ENUM
 ('queued','planning','running','awaiting_approval','paused','completed','failed','cancelled');
CREATE TYPE approval_status AS ENUM ('pending','approved','rejected','expired','revoked','consumed');
CREATE TYPE tool_status AS ENUM ('proposed','denied','awaiting_approval','queued','running','succeeded','failed','cancelled');

CREATE TABLE organizations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE users (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL REFERENCES organizations(id),
 oidc_subject text NOT NULL UNIQUE, email text NOT NULL,
 is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE memberships (
 org_id uuid NOT NULL REFERENCES organizations(id), user_id uuid NOT NULL REFERENCES users(id),
 role text NOT NULL CHECK (role IN ('org_admin','engagement_owner','scope_reviewer','analyst','action_approver','viewer','platform_operator')),
 PRIMARY KEY (org_id,user_id,role)
);
CREATE TABLE projects (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL REFERENCES organizations(id),
 name text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (org_id,name)
);
CREATE TABLE engagements (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL REFERENCES organizations(id),
 project_id uuid NOT NULL REFERENCES projects(id), title text NOT NULL,
 status engagement_status NOT NULL DEFAULT 'draft', current_scope_version int,
 created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE engagement_scope_versions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), engagement_id uuid NOT NULL REFERENCES engagements(id),
 version int NOT NULL CHECK (version > 0), scope_json jsonb NOT NULL,
 authorization_object_key text NOT NULL, document_sha256 char(64) NOT NULL,
 reviewer_id uuid REFERENCES users(id), reviewed_at timestamptz,
 approved boolean NOT NULL DEFAULT false, revoked_at timestamptz,
 valid_from timestamptz NOT NULL, valid_until timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (engagement_id,version), CHECK (valid_until > valid_from),
 CHECK (NOT approved OR (reviewer_id IS NOT NULL AND reviewed_at IS NOT NULL))
);
CREATE TABLE assets (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL REFERENCES organizations(id),
 project_id uuid NOT NULL REFERENCES projects(id), kind text NOT NULL CHECK (kind IN ('domain','ip','cidr','repo')),
 value text NOT NULL, metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE TABLE agent_runs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL REFERENCES organizations(id),
 engagement_id uuid NOT NULL REFERENCES engagements(id), mode text NOT NULL CHECK (mode IN ('hybrid','interactive','autonomous')),
 status run_status NOT NULL DEFAULT 'queued', objective text NOT NULL,
 scope_version int NOT NULL, created_by uuid NOT NULL REFERENCES users(id),
 step_budget int NOT NULL DEFAULT 25, deadline_at timestamptz NOT NULL,
 cancel_requested boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE agent_tasks (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), run_id uuid NOT NULL REFERENCES agent_runs(id),
 agent_name text NOT NULL, status text NOT NULL, input_json jsonb NOT NULL,
 output_json jsonb, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE tool_executions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), run_id uuid NOT NULL REFERENCES agent_runs(id),
 action_type text NOT NULL, asset_id uuid NOT NULL REFERENCES assets(id),
 canonical_params jsonb NOT NULL, params_sha256 char(64) NOT NULL,
 status tool_status NOT NULL DEFAULT 'proposed', policy_version text NOT NULL,
 decision_reason text, idempotency_key text NOT NULL UNIQUE,
 worker_id text, started_at timestamptz, ended_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE approvals (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tool_execution_id uuid NOT NULL UNIQUE REFERENCES tool_executions(id),
 status approval_status NOT NULL DEFAULT 'pending', payload_sha256 char(64) NOT NULL,
 requested_by uuid NOT NULL REFERENCES users(id), decided_by uuid REFERENCES users(id),
 decision_reason text, expires_at timestamptz NOT NULL,
 decided_at timestamptz, consumed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE findings (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL REFERENCES organizations(id),
 engagement_id uuid NOT NULL REFERENCES engagements(id),
 asset_id uuid NOT NULL REFERENCES assets(id), title text NOT NULL,
 severity text NOT NULL CHECK (severity IN ('informational','low','medium','high','critical')),
 status text NOT NULL DEFAULT 'draft', description text NOT NULL,
 remediation text, confidence numeric(4,3) CHECK (confidence BETWEEN 0 AND 1),
 fingerprint text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (engagement_id,fingerprint)
);
CREATE TABLE evidence (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), finding_id uuid REFERENCES findings(id),
 tool_execution_id uuid REFERENCES tool_executions(id),
 object_key text NOT NULL, sha256 char(64) NOT NULL, mime_type text NOT NULL,
 redaction_status text NOT NULL DEFAULT 'pending', created_at timestamptz NOT NULL DEFAULT now(),
 CHECK (finding_id IS NOT NULL OR tool_execution_id IS NOT NULL)
);
CREATE TABLE audit_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, org_id uuid NOT NULL REFERENCES organizations(id),
 actor_type text NOT NULL, actor_id text NOT NULL, event_type text NOT NULL,
 event_json jsonb NOT NULL, previous_hash char(64), event_hash char(64) NOT NULL,
 occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE model_usage (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), run_id uuid NOT NULL REFERENCES agent_runs(id),
 model_name text NOT NULL, prompt_tokens bigint NOT NULL DEFAULT 0,
 completion_tokens bigint NOT NULL DEFAULT 0, latency_ms int,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_runs_engagement_status ON agent_runs(engagement_id,status);
CREATE INDEX idx_tools_run_status ON tool_executions(run_id,status);
CREATE INDEX idx_approvals_status_expiry ON approvals(status,expires_at);
CREATE INDEX idx_audit_org_time ON audit_events(org_id,occurred_at DESC);
```

**Hardening additions before production:** composite tenant-aware foreign keys or triggers; RLS for every tenant-owned table using authenticated tenant context; append-only audit table privileges, WAL archiving, backup encryption, uniqueness on approval consumption and worker leases; `SELECT ... FOR UPDATE` transitions; durable outbox for dispatch; partition high-volume logs; evidence retention and tenant deletion policy. Hash chaining is tamper-evident only when head hashes are regularly anchored off-host; a DB superuser can rewrite local history.

### 5.1 Data lineage rules

- Reports link finding -> evidence -> tool execution -> run -> scope version -> reviewer.
- Agent retrieval must always filter `org_id` and engagement/project ACL **before** similarity ranking.
- Storing malicious text from a target must never make it trusted instructions.
- Never store bearer credentials, cookies, private keys, or database dumps in raw chat logs.

---

## 6. HTTP API contracts (versioned `/api/v1`)

### 6.1 Common requirements

- Authentication: OIDC JWT with verified `iss`, `aud`, `exp`, `kid`; reject unknown algorithms and stale JWKS.
- Authorization: org membership and resource ownership checked at each API request.
- Mutations: `Idempotency-Key` header; `X-Request-ID` for tracing.
- Pagination: `limit` 1–100, opaque `cursor`; all results filtered by tenant.
- Dates: ISO 8601 UTC; UUID identifiers.
- Schema: OpenAPI generated from FastAPI; frontend types generated from OpenAPI build artifact.
- Error format:

```json
{
  "error": {
    "code": "SCOPE_NOT_APPROVED",
    "message": "The engagement has no valid approved scope",
    "request_id": "req_123",
    "details": {"engagement_id": "uuid"}
  }
}
```

Suggested statuses: 400 malformed, 401 unauthenticated, 403 forbidden/out-of-scope, 404 tenant-invisible, 409 stale state/version, 422 validation, 429 rate-limit, 503 dependency unavailable.

### 6.2 Route catalog

| Method | Route | Who | Body / response |
|---|---|---|---|
| GET | `/auth/me` | signed-in | current profile/roles |
| GET/POST | `/projects` | viewer / owner | project list/create |
| GET/POST | `/engagements` | viewer / owner | engagement list/create |
| GET | `/engagements/{id}` | viewer | engagement detail |
| POST | `/engagements/{id}/scope-versions` | owner | immutable draft scope revision |
| POST | `/engagements/{id}/scope-versions/{version}/submit` | owner | submit for review |
| POST | `/engagements/{id}/scope-versions/{version}/approve` | scope_reviewer | sign/review scope |
| POST | `/engagements/{id}/revoke` | scope_reviewer | revoke and cancel active jobs |
| GET/POST | `/engagements/{id}/runs` | viewer / analyst | list or create hybrid run |
| GET | `/runs/{id}` | viewer | run status, summary |
| POST | `/runs/{id}/pause` | analyst | pause queued operations |
| POST | `/runs/{id}/resume` | analyst | resume after rechecks |
| POST | `/runs/{id}/cancel` | analyst | cancel and terminate workers |
| GET | `/runs/{id}/events` | viewer | SSE stream with resume cursor |
| GET | `/runs/{id}/tasks` | viewer | DAG tasks and statuses |
| GET | `/runs/{id}/tool-executions` | viewer | sanitized tool event list |
| GET | `/approvals?status=pending` | approver | pending approval queue |
| GET | `/approvals/{id}` | approver | immutable action snapshot, risk, scope |
| POST | `/approvals/{id}/decision` | approver | approve/reject request |
| GET/POST/PATCH | `/engagements/{id}/findings` | analyst | findings management |
| GET | `/findings/{id}/evidence` | viewer | sanitized evidence metadata |
| POST | `/engagements/{id}/reports` | analyst | asynchronous report generation |
| GET | `/reports/{id}` | viewer | report status and signed download |
| GET | `/system/models` | operator | model state, tokens, queue |
| GET | `/system/health` | operator | protected component health |
| POST | `/system/emergency-stop` | designated admin | globally deny and stop execution |

**No public API for direct arbitrary target execution.** Tool gateway is a separate private service and is callable only by authenticated scheduler identities using mTLS/workload credentials.

### 6.3 Create engagement

`POST /api/v1/engagements`

```json
{"project_id":"uuid","title":"Authorized staging assessment","description":"Quarterly web review"}
```

`201`:

```json
{"id":"uuid","status":"draft","current_scope_version":null}
```

### 6.4 Start Hybrid run

`POST /api/v1/engagements/{engagement_id}/runs` with `Idempotency-Key`:

```json
{
  "mode": "hybrid",
  "objective": "Inventory exposed HTTPS services and review safe configuration checks",
  "asset_ids": ["uuid"],
  "max_steps": 25,
  "max_duration_minutes": 30,
  "max_requests_per_second": 1
}
```

Server validates approved scope, window, capability set, tenant, limits and active model. `202`:

```json
{"run_id":"uuid","status":"queued","scope_version":3,"events_url":"/api/v1/runs/uuid/events"}
```

All client-provided limits can only **tighten**, never expand, approved scope limits.

### 6.5 Approval contract

`GET /api/v1/approvals/{id}`:

```json
{
  "id":"uuid",
  "status":"pending",
  "action_type":"approved_web_metadata_check",
  "target":{"asset_id":"uuid","resolved_ip":"192.0.2.4","port":443},
  "canonical_params":{"path":"/health","method":"HEAD","follow_redirects":false},
  "payload_sha256":"64-hex-digits",
  "risk":"medium",
  "reason":"Operator review required by engagement policy",
  "scope_version":3,
  "expires_at":"2026-10-15T10:00:00Z"
}
```

`POST /api/v1/approvals/{id}/decision`:

```json
{
  "decision":"approve",
  "expected_payload_sha256":"64-hex-digits",
  "reason":"Approved limited HEAD check for staging endpoint"
}
```

Server verifies reviewer role, optional separation of duties, unchanged payload, unexpired scope and action, available execution budget, and approval freshness. **Approval is single use.** Changing parameters creates a new tool execution and new approval request.

### 6.6 SSE event taxonomy

```text
event: agent.plan.created
data: {"run_id":"uuid","task_count":3}

event: tool.approval_required
data: {"run_id":"uuid","approval_id":"uuid"}

event: tool.completed
data: {"run_id":"uuid","tool_execution_id":"uuid","status":"succeeded"}

event: run.completed
data: {"run_id":"uuid","findings":2}
```

Events include monotonically increasing event IDs; reconnect with `Last-Event-ID`, enforce per-tenant filters, and never stream raw secrets.

---

## 7. Agent state machines and LangGraph integration

### 7.1 Top-level run states

```mermaid
stateDiagram-v2
  [*] --> QUEUED
  QUEUED --> PLANNING: scope valid
  PLANNING --> RUNNING: plan approved by policy
  RUNNING --> AWAITING_APPROVAL: gated tool proposed
  AWAITING_APPROVAL --> RUNNING: approval + revalidation
  AWAITING_APPROVAL --> RUNNING: denial -> skip + replan
  RUNNING --> PAUSED: operator pause
  PAUSED --> RUNNING: resume + revalidation
  RUNNING --> COMPLETED: findings/report ready
  PLANNING --> FAILED: exception
  RUNNING --> FAILED: unrecoverable error
  QUEUED --> CANCELLED: stop
  RUNNING --> CANCELLED: stop / revoke
  AWAITING_APPROVAL --> CANCELLED: stop / revoke
  COMPLETED --> [*]
  FAILED --> [*]
  CANCELLED --> [*]
```

### 7.2 Graph nodes

`validate_scope -> clarify_objective -> plan -> classify_actions -> (policy_check -> queue_tool -> collect_output -> analyze -> next_task)* -> reconcile_findings -> report -> end`

For gated operations: `policy_check -> create_approval -> interrupt -> resume_only_after_approval -> revalidate -> dispatch`.

The policy service must be called at **run creation, plan acceptance, tool enqueue, worker execution, each outbound request and resume**. A LangGraph interrupt is a workflow convenience, not the security enforcement layer.

### 7.3 State contract

```python
from typing import TypedDict, Literal

class AgentState(TypedDict):
    run_id: str
    engagement_id: str
    org_id: str
    scope_version: int
    mode: Literal['hybrid', 'interactive', 'autonomous']
    objective: str
    plan: list[dict]
    pending_tool_id: str | None
    completed_tool_ids: list[str]
    findings: list[dict]
    step_budget_remaining: int
    cancelled: bool
```

### 7.4 Dispatch guard pseudocode

```python
async def authorize_and_dispatch(run_id: str, tool_request: TypedToolRequest):
    # Run/engagement/scope fetched from trusted DB, not agent-supplied state.
    async with db.transaction() as tx:
        run = await tx.lock_run(run_id)
        scope = await tx.load_current_approved_scope(run.engagement_id)
        if run.cancel_requested or not scope or not scope.in_valid_window():
            raise PolicyDenied('No executable authorization')
        requested = canonicalize_and_resolve(tool_request, scope)
        decision = policy.evaluate(run=run, scope=scope, request=requested)
        if decision.kind == 'DENY':
            await tx.audit_denial(requested, decision)
            raise PolicyDenied(decision.reason)
        execution = await tx.insert_tool_execution(requested, decision)
        if decision.kind == 'REQUIRE_APPROVAL':
            await tx.create_single_use_approval(execution)
            return {'status': 'awaiting_approval', 'tool_id': str(execution.id)}
        await tx.insert_outbox_event('dispatch_tool', execution.id)
    return {'status': 'queued', 'tool_id': str(execution.id)}
```

**On worker start:** recheck policy and exact payload hash, lock+consume approval atomically if required, mint a short-lived single-task capability, execute, and revoke the capability. The egress gateway verifies token target/port/protocol limits separately.

### 7.5 Deterministic transitions

- `planning` can produce structured proposals only; it cannot issue network calls.
- `awaiting_approval` suspends the affected task while other **independent, permitted** tasks may continue.
- Rejections become structured feedback; agent may suggest a safer alternative but may not transform the denied action into an equivalent unapproved operation.
- Errors retry only idempotent low-impact actions, bounded by budget and exponential backoff.
- End a run when deadline, steps or spend budget is exhausted.

---

## 8. Typed tool gateway

### 8.1 Initial tools (MVP)

| Tool identifier | Input (strict schema) | Class | Permission |
|---|---|---|---|
| `lookup_advisory` | CVE/OSV ID | no target contact | automatic |
| `read_authorized_repository` | repository asset ID, commit, limited path | passive | automatic |
| `semgrep_review` | repository asset ID, ruleset ID | passive/local | automatic |
| `inspect_http_headers` | approved web asset ID, permitted path | low impact | automatic **only when pre-authorized** |
| `safe_service_inventory` | approved CIDR asset ID, approved port-set ID | low impact | approval or tightly pre-approved playbook |
| `extract_scan_findings` | stored evidence ID | offline | automatic |
| `generate_report` | engagement ID, template ID | offline | automatic |

A future gated validation plugin must declare capabilities, impact rating, schemas and its own policy tests. No generic exploit or credential tools in MVP.

### 8.2 Tool request example

```json
{
  "tool_id":"inspect_http_headers",
  "asset_id":"uuid",
  "parameters": {"path":"/","method":"HEAD"},
  "rationale":"Review baseline response headers"
}
```

All args use strict `additionalProperties: false`, enumerated methods/paths, fixed timeouts and server-specified flags. The agent cannot provide hostnames in place of asset IDs, or inject raw CLI arguments. Routes, redirect destinations, DNS records, HTTP CONNECT, proxies and IPv6 must remain scoped.

### 8.3 Plugin registration interface

```python
class ToolDescriptor(BaseModel):
    id: str
    action_type: str
    impact: Literal['offline','passive','low','intrusive','forbidden']
    max_runtime_seconds: int
    requires_target: bool
    schema_version: int

class ToolAdapter(Protocol):
    descriptor: ToolDescriptor
    async def execute(self, approved: 'ExecutionCapability') -> 'SanitizedToolResult': ...
```

Adapters receive immutable policy-bound parameters from the execution service, not raw chat data. Tool descriptors cannot mark an intrusive capability as passive without a reviewed code change. Registry definitions and binaries should be signed and pinned.

### 8.4 Sandbox rules

- Tools run as a non-root UID, read-only root filesystem, dropped Linux capabilities, `no-new-privileges`, seccomp/AppArmor, CPU/RAM/PID limits, short timeout, temporary working directory.
- No `--privileged`, no host PID/network namespace, no Docker socket, no cloud metadata access, no host secrets mount, no unrestricted outbound network.
- For external target contact, route through a destination-enforcing egress proxy; configure firewall to disallow direct bypass.
- Prefer one ephemeral worker per task, with immutable base image and signed artifact manifests.
- Scan all evidence for secrets and confidential data before persisting or showing it.
- Captured artifacts are hashed; object access uses tenant-aware, short-lived signed URLs.

### 8.5 Policy engine decision

```json
{
  "decision": "REQUIRE_APPROVAL",
  "reasons": ["action_requires_human_gate"],
  "policy_version": "2026.10.1",
  "scope_version": 3,
  "effective_limits": {"rps":1,"timeout_seconds":30},
  "canonical_request_sha256": "64-hex-digits"
}
```

Decision enum: `ALLOW`, `REQUIRE_APPROVAL`, `DENY`. **Never interpret model confidence as authorization.** For forbidden categories always `DENY` in MVP, even after a human presses Approve.

---

## 9. Dashboard / UI specification

### 9.1 Routes

| Route | Page and required controls |
|---|---|
| `/login` | OIDC login + MFA |
| `/dashboard` | overview, queued approvals, active runs, recent findings, GPU health |
| `/projects` | project list, search, roles |
| `/projects/[projectId]` | assets, engagements, reports |
| `/engagements/new` | wizard: owner, objectives, authorization evidence, assets, allowed actions, windows, limits |
| `/engagements/[id]/scope` | immutable scope revision diff, review signatures, revoke button |
| `/engagements/[id]/runs/new` | Hybrid plan, scope-bound assets, time/RPS limits |
| `/runs/[id]` | live conversation, agent graph, event timeline, evidence panel, pause/stop |
| `/approvals` | pending review table, risk, exact payload hash, allow/reject + reason |
| `/approvals/[id]` | source task, scope and safety impact, immutable action preview |
| `/findings` | filter status/severity/asset, dedupe |
| `/findings/[id]` | evidence, remediation, owner, reviewer |
| `/reports` | draft generation and export history |
| `/models` | inference model, VRAM, tokens/s, queue depth, cost estimate |
| `/audit` | append-only event viewer, filters, export restricted by role |
| `/settings/security` | identity, retention, policy version, kill switch, secrets health |

### 9.2 Hybrid run layout

Desktop: narrow left sidebar (navigation) + central work area (chat and live graph tabs) + right rail (scope version, tool proposal, approval status, evidence links). Mobile: collapse panels; do not expose raw terminal write access. Use neutral dark palette with measured status colors only.

### 9.3 Approval UX requirements

- Always display requested action, exact target, resolved address/port, operation parameters, expected network impact, scope authorization, expiry and requester.
- Positive confirmation must include approval reason and optional MFA step-up for intrusive operations (when later supported).
- Approver sees a diff if anything changed; changed parameters force new approval.
- Clicking Approve does not bypass policy; show denial if the execution window expired or scope revoked.
- Dedicated persistent emergency-stop control available to authorized operators.

### 9.4 Frontend state

TanStack Query for server data; SSE for run-event updates; Zod validation for user forms; no secrets in localStorage; use server-managed HTTP-only secure sessions where feasible. Accessible keyboard navigation and clear stop/paused/error states.

---

## 10. Deployment: single rented B200 host

### 10.1 Provisioning order

1. Rent a B200 server from a provider permitting your **authorized** security assessment workloads. Confirm their terms, GPU SKU, network egress rules, disk persistence, virtualization support, bandwidth charges and shutdown billing.
2. Install vendor-supported Ubuntu LTS, NVIDIA driver and compatible CUDA/runtime; run `nvidia-smi` and a vLLM GPU smoke test.
3. Create unprivileged admin account; disable password SSH, enable SSH key auth, firewall, VPN administration, time sync, automatic security updates, disk encryption where supported.
4. Configure private DNS/TLS and restrict UI to trusted IPs/VPN; never expose vLLM, Redis, PostgreSQL, MinIO or the worker gateway publicly.
5. Create encryption keys and OIDC client secrets outside source control. Provision **off-host** encrypted backup destination before test engagements.
6. Start storage and auth dependencies; run migrations; start API/web; verify authentication/authorization tests.
7. Start vLLM with selected model; benchmark 4k/16k/32k context, tool-call schema validity and parallel requests.
8. Start tool gateway with **all active network tools disabled** until scope and egress enforcement tests pass.
9. Start isolated workers and policy-controlled egress; test allowed lab IP and denied public IP.
10. Register one test engagement, review scope as a different user, run safe check, test approval, produce report.

### 10.2 `.env.example` (never commit actual secrets)

```dotenv
APP_ENV=development
PUBLIC_BASE_URL=https://redteam.example.internal
DATABASE_URL=postgresql+psycopg://redteam:CHANGE_ME@postgres:5432/redteam
REDIS_URL=redis://redis:6379/0
S3_ENDPOINT=http://minio:9000
S3_BUCKET=redteam-evidence
S3_ACCESS_KEY=CHANGE_ME
S3_SECRET_KEY=CHANGE_ME
OIDC_ISSUER_URL=https://id.example.internal/realms/tatvam
OIDC_AUDIENCE=tatvam-redteam-api
OIDC_CLIENT_ID=redteam-web
VLLM_API_BASE=http://vllm:8000/v1
VLLM_API_KEY=CHANGE_ME
PRIMARY_MODEL=tatvam-reasoner
AUTO_TARGET_ACTIONS_ENABLED=false
EMERGENCY_STOP_DEFAULT=true
POLICY_VERSION=2026.10.1
MAX_CONCURRENT_RUNS=1
```

### 10.3 Illustrative `infra/compose.yaml`

**This is a topology skeleton, not a production-hardened compose file.** Image digest pinning, secret files, healthchecks, volume encryption, resource constraints, authenticated proxy and VM worker provisioning remain implementation work. Do not deploy security tool workers on this permissive Compose network.

```yaml
name: tatvam-redteam
services:
  postgres:
    image: pgvector/pgvector:pg16
    environment:
      POSTGRES_USER: redteam
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?set-secret}
      POSTGRES_DB: redteam
    volumes: ["pgdata:/var/lib/postgresql/data"]
    networks: [internal]
    restart: unless-stopped
  redis:
    image: redis:7-alpine
    command: ["redis-server", "--appendonly", "yes"]
    volumes: ["redisdata:/data"]
    networks: [internal]
  minio:
    image: minio/minio:REPLACE_WITH_TESTED_PINNED_TAG
    command: server /data --console-address :9001
    environment:
      MINIO_ROOT_USER: ${MINIO_ROOT_USER:?set-secret}
      MINIO_ROOT_PASSWORD: ${MINIO_ROOT_PASSWORD:?set-secret}
    volumes: ["miniodata:/data"]
    networks: [internal]
  vllm:
    image: vllm/vllm-openai:REPLACE_WITH_TESTED_CUDA_B200_COMPATIBLE_TAG
    command:
      - --model
      - ${MODEL_REPOSITORY:?choose-verified-model}
      - --served-model-name
      - tatvam-reasoner
      - --host
      - 0.0.0.0
      - --port
      - '8000'
      - --api-key
      - ${VLLM_API_KEY:?set-secret}
    environment:
      HF_TOKEN: ${HF_TOKEN:-}
    gpus: all
    volumes: ["modelcache:/root/.cache/huggingface"]
    networks: [internal]
    shm_size: 8gb
  api:
    build: ../../services/api
    env_file: ../../.env
    depends_on: [postgres, redis, minio, vllm]
    networks: [internal]
    restart: unless-stopped
  web:
    build: ../../apps/web
    depends_on: [api]
    networks: [internal]
    restart: unless-stopped
  gateway:
    image: caddy:2
    volumes:
      - ./gateway/Caddyfile:/etc/caddy/Caddyfile:ro
    ports: ["443:443"]
    depends_on: [web, api]
    networks: [internal]
volumes:
  pgdata: {}
  redisdata: {}
  miniodata: {}
  modelcache: {}
networks:
  internal:
    internal: true
```

**Critical networking note:** `internal: true` isolates the services from outside networks. This example cannot serve external OIDC/Hugging Face or authorized targets without separately designed connectivity. Set up a narrowly controlled ingress/download path and a **distinct** egress network/service for approved tool workers; do not simply set `internal: false` on the common backend network. The external HTTPS ingress route also needs a provider-appropriate proxy/firewall setup. Pull model weights in a controlled provisioning step rather than exposing runtime containers broadly.

### 10.4 vLLM

Verify current B200-compatible image and model support first. Example, for a **single GPU model that fits**:

```bash
vllm serve "$MODEL_REPOSITORY" \
  --served-model-name tatvam-reasoner \
  --tensor-parallel-size 1 \
  --host 127.0.0.1 --port 8000 \
  --api-key "$VLLM_API_KEY"
```

Containerized serving uses `0.0.0.0` **inside a private container network** instead of host-local binding. Do not copy this model invocation without validating license, quantization, CUDA/driver, memory and tool-call template support. Tool calling varies by model; run a benchmark before committing to a model.

### 10.5 Shutdown and recovery

- Stop/pause runs; revoke capabilities; flush audit outbox; store manifests and backup database/artifact metadata.
- Encrypted backup to independent storage with retention and integrity checks; test restore to a clean instance.
- Do not assume Docker volumes survive GPU server termination. Keep IaC and deployment manifests outside the rented host.
- After restore, do **not** resume outstanding approved operations automatically. Revalidate scope and explicitly restart jobs.

---

## 11. Security model and failure handling

### 11.1 Principal trust boundaries

1. Browser and remote users are untrusted until OIDC and tenant checks.
2. LLM output is untrusted **even if the model is self-hosted**.
3. Target content, documents, scan output, tool responses and MCP metadata are untrusted.
4. Agent/worker identities are not user approval identities.
5. Runner kernel/network controls must be enforceable independently of agents.
6. Storage administrator access is not equivalent to customer authorization.

### 11.2 Controls

- Signed engagement evidence with expiry and independent review.
- Strict parameter validation, network destination validation and immutable action snapshot.
- Two-phase dispatch: policy/approval before enqueue, policy/approval again inside worker.
- Atomic approval consumption; action retry with same idempotency key is denied after consumption unless explicitly designed as safe and idempotent.
- Workload identity rotation; short-lived scoped credentials; protected audit storage.
- Model prompt includes security posture, but no security decision relies on prompt compliance.
- Full request tracing with sensitive data masking; maximum event size; binary attachment quarantine.
- Risk-based human approval; deny on unavailable policy service/database/identity provider.
- Default deny during emergency stop; command fails closed when proxy cannot validate scope.

### 11.3 Failure modes

| Failure | Required behavior |
|---|---|
| Expired scope during scan | Stop tool, revoke capability, mark run paused/cancelled |
| DNS resolves outside CIDR | Block connection, audit reason |
| HTTP redirect out of scope | Do not follow; log sanitized redirect |
| Agent suggests forbidden operation | Deny; send structured explanation to planner |
| Approval expires | Never execute; create new approval if still needed |
| Approved action parameters change | Hash mismatch -> deny |
| Worker crash | Mark uncertain state, do not blindly replay gated action |
| Redis redelivery | Dedup by durable execution ID and idempotency key |
| Model service down | Pause run safely; never fall back to unapproved external API |
| Prompt injection in webpage | Treat as data; model cannot mutate tool policy |
| Emergency stop | Revoke leases, terminate workers, disable egress |
| Host compromise | Rotate all credentials, restore off-host backup, investigate |

---

## 12. Development instructions by milestone

### Milestone 0 — Foundation and threat model (days 1–4)

**Work:** write ADRs, dataflow/trust diagram, control matrix; initialize pnpm+Python monorepo, pre-commit hooks, CI, linting, dependency lockfiles, lint+test gates. Create `docs/threat-model.md` and engagement authorization template.

**Exit criteria:** every external data flow documented; forbid-list formally approved; CI rejects failing tests and leaked secrets.

### Milestone 1 — Database, identity, scope (weeks 1–2)

1. Implement DB schema, Alembic migration and seed lab tenant.
2. Integrate OIDC JWKS, tenant middleware, RBAC and RLS.
3. Build engagement create/review/revoke API with immutable scope revisions.
4. Build dashboard project, scope editor and reviewer pages.
5. Unit test scope expiry, tenant escape, same-user reviewer limits and revoked scopes.

**Exit criteria:** zero target-contacting action is possible without an approved signed scope; scope review is independently audited.

### Milestone 2 — Hybrid agent core (weeks 3–4)

1. Deploy vLLM and benchmark candidate model on tool-call structured output and refusal-safe boundary checks.
2. Implement LangGraph supervisor with deterministic planning/checkpointing.
3. Add run API, SSE, step/time budgets, run cancel/pause/resume.
4. Implement `policy.evaluate()` as pure deterministic code and human interrupt path.
5. Add `lookup_advisory` and `semgrep_review` (offline first) adapters.

**Exit criteria:** one run completes offline repository review and report; injected tool results cannot cause new tool permissions.

### Milestone 3 — Tool gateway and explicit approval (weeks 5–6)

1. Create tool registry with strict Pydantic models and canonical SHA-256 request hashing.
2. Implement policy evaluation at proposed, enqueued, and worker-start phases.
3. Build approvals list/detail/decision pages with immutable payload display and one-time consume.
4. Build isolated worker runner; no host mounts; network disabled by default.
5. Add lab-only approved HTTP header inspection through allowlisted egress proxy.

**Exit criteria:** denied target/redirect/DNS/replay tests pass; approved action executes once, rejected action never executes.

### Milestone 4 — Findings, evidence, reporting (weeks 7–8)

1. Store sanitized structured tool results and their hashes in MinIO.
2. Add finding fingerprint, dedupe, severity/confidence and analyst verification fields.
3. Build findings/evidence/report UI and export pipeline (Markdown/HTML/PDF).
4. Add immutable audit event trail and admin incident view.
5. Backup/restore exercises on a fresh instance.

**Exit criteria:** reports trace all claims to evidence and scope; no secrets in standard exports; restored service maintains integrity.

### Milestone 5 — Hardening and pilot (weeks 9–11)

1. Execute abuse tests: prompt injection, SSRF, cross-tenant access, stale approvals, worker crash/retry and cancellation races.
2. Chaos tests: Redis/Postgres/vLLM unavailable; scope revoked mid-run; worker loses connection.
3. Load tests: 1–2 concurrent runs, SSE reconnect, event processing, CPU/RAM/VRAM headroom.
4. Security code review; third-party dependency/container image scan; external penetration test of platform itself.
5. Restricted pilot on an intentionally vulnerable **owned lab** and one authorized staging environment.

**Exit criteria:** scope/approval critical controls have zero bypasses; emergency stop verified at gateway/network layer; owner signs release checklist.

### Milestone 6 — Later releases

- Interactive mode: analyst-controlled per-command workflow built on the same gateway.
- Autonomous mode: signed low-impact playbooks only, schedule and strict usage limits, automatic stop on anomalies.
- Optional scaling: separate CPU workers, persistent database, dedicated policy service, multi-GPU model routing, Temporal, SIEM integration.

**Timeline:** indicative for a small experienced team; GPU compatibility, network isolation and auth audit may extend delivery.

---

## 13. Test matrix and CI gates

### 13.1 Unit tests

- `test_policy_denies_missing_scope`
- `test_policy_denies_unreviewed_scope`
- `test_policy_denies_expired_window`
- `test_policy_denies_asset_not_listed`
- `test_policy_denies_disallowed_action`
- `test_policy_limits_only_tightened_by_user`
- `test_parameter_canonicalization_stable`
- `test_approval_hash_change_invalidates`
- `test_approval_single_use`
- `test_separation_of_duties`
- `test_forbidden_action_never_approvable`

### 13.2 Integration tests

- OIDC/JWKS verification; tenant isolation and RLS.
- Scope approval/revocation while run active.
- Tool queue transaction/outbox atomicity; Redis redelivery idempotency.
- IP/CIDR + DNS-rebinding simulation; blocked redirects and IPv6 escape.
- Egress firewall test: worker attempts to contact public disallowed destination => refused.
- Worker resource exhaustion; timeout; kill switch; revoked lease.
- MinIO signed URL tenant checks and encrypted off-host restore.

### 13.3 Agent evaluation tests

Build a fixture corpus of benign authorized tasks, false-positive advisories, malicious prompt-injection scan outputs, ambiguous requests and attempts to override scope. Expected behavior: do useful authorized analysis, make typed proposals, refuse forbidden tool dispatch, request approval for gated actions, and cite evidence reliably. Model test performance must be measured after every model/prompt/tool change.

### 13.4 E2E tests (Playwright)

1. Scope creator submits draft; separate reviewer approves.
2. Analyst launches Hybrid run; sees plan and logs.
3. Gated tool triggers approval card with exact payload and target.
4. Reviewer rejects; task skips and audit logs decision.
5. Fresh proposal approved; action executes once in owned lab.
6. Scope revoked mid-run; worker terminated and run no longer able to dispatch.
7. Report generated, reviewer sees sanitized evidence lineage.

### 13.5 Security regression testing

Adversarial prompts should include statements such as 'ignore previous rules', fake tool-result instructions, fake scope documents, forged agent-role messages, arbitrary URLs, private-address redirects and unexpected tool parameters. Assert all are treated as untrusted input and **cannot change scope**. Test no allowlist bypass through case normalization, Unicode/punycode, userinfo segments, encoding, IPv4-mapped IPv6, redirect chains or proxy headers.

### 13.6 CI acceptance gates

- Backend: `ruff`, `mypy`, `pytest`; coverage threshold on policy/gateway modules >=95% as an initial target.
- Frontend: ESLint, TypeScript strict, Vitest, Playwright.
- OpenAPI schema diff; migration up/down validation; SBOM, dependency/SAST/image scan.
- Zero critical/high security findings unresolved for production release; documented acceptance of any lower-risk findings.
- Required sign-off from one independent security reviewer for policy/runner/network changes.

---

## 14. Observability, cost and operations

### 14.1 Metrics

`gpu_vram_utilization`, `gpu_utilization`, `tokens_per_second`, `llm_request_latency`, `agent_run_duration`, `tool_policy_denials`, `pending_approvals_age`, `worker_timeout_count`, `egress_denials`, `scope_revocations`, `audit_pipeline_lag`, `evidence_store_growth`, `backup_last_success`.

### 14.2 Notifications

Notify operators on pending approvals, run failures, policy-denial spikes, possible scope violation, emergency stop, expiring authorization and backup failure. Do not send full secret-bearing logs to email/Slack.

### 14.3 Cost logic

- GPU hourly rental is primary expense; model API token costs become infrastructure utilization costs.
- Track wall-clock run time, inference tokens, GPU utilization and storage by engagement.
- Idle shutdown must only happen after persisting state and off-host backup; model warm-up and instance start times affect economics.
- Use separate small CPU host and off-host data plane for production even if single GPU host is accepted for the initial MVP.

### 14.4 Runbooks

Create `docs/runbooks/` for deploy, rollback, rotate secrets, revoke scope, global kill switch, recover failed worker, restore backup, audit suspected prompt-injection incident, and respond to unexpected egress attempt.

---

## 15. Agentic coding handoff plan

For your coding assistant, feed this specification in small milestone tasks. Have the coding agent implement **one vertical slice at a time**; do not ask it to build the entire security platform and enable scanning in a single unreviewed PR.

### Prompt A — project scaffolding

> Read `TATVAM_AI_RED_TEAM_IMPLEMENTATION.md`. Implement Milestone 0 only. Create the Next.js + FastAPI monorepo, Docker development services excluding tool workers, CI, architecture decision records, threat model skeleton and README. Follow TypeScript/Python strict typing. Do not implement any target-contacting functionality. Output a file tree, commands to run, tests and unresolved decisions. Do not claim completion unless tests execute successfully.

### Prompt B — scope/identity subsystem

> Implement Milestone 1. Create PostgreSQL/Alembic tables, OIDC JWT verification, RBAC, approved scope versions, reviewer separation and revoke API. Add unit and integration tests for missing/expired/unapproved/revoked scope and cross-tenant access. All target-contacting features remain disabled by default. Provide migrations, OpenAPI and frontend reviewer screens. Stop if issuer/provider config is missing; never hardcode a secret.

### Prompt C — hybrid supervisor

> Implement the Milestone 2 LangGraph Hybrid run planner with Postgres checkpoints, SSE run events, strict budgets and read-only offline `lookup_advisory` / `semgrep_review` adapters. Add deterministic policy evaluation. No direct network access from agents. Add adversarial prompt-injection fixtures and demonstrate no tool-policy override.

### Prompt D — secure gateway

> Implement Milestone 3 typed tool descriptors, canonical immutable request hashes, stateful one-time approvals, policy checks on enqueue and worker start, auditable denials, and isolated job execution with network disabled by default. Write failure-mode tests before enabling any target contact. Implement a simulated test adapter and prove denied operation cannot execute after scope revocation. Do not add arbitrary shell execution.

### Prompt E — approved staging checks

> Only after the gateway and egress isolation tests pass, implement one low-impact HTTP metadata check for a fixed lab asset. Require a reviewed scope, enforce DNS/address/redirect policy through destination-aware proxy, and apply RPS, timeout and idempotency constraints. If networking restrictions cannot be demonstrated, leave this feature disabled and document the blocker.

### Prompt F — release verification

> Implement findings/evidence/reporting, off-host backup manifest, incident logging and release tests. Produce a traceability matrix of every security invariant to a test and code location. Do not mark release-ready until required independent reviews and restore drills are complete.

---

## 16. Delivery checklist

- [ ] Rented provider permits authorized testing and B200 verified
- [ ] Signed authorization evidence and reviewer workflow implemented
- [ ] Immutable scope revisions and revocation cascade implemented
- [ ] Default-deny policy lives outside model/agent
- [ ] All target-contacting tools pass through typed gateway
- [ ] Network egress cannot bypass destination scope
- [ ] Approval is immutable, single-use, short-lived and hash-bound
- [ ] Worker isolation reviewed; no privileged Docker/shell escapes
- [ ] Emergency stop works on active workers and pending jobs
- [ ] Secrets, evidence, logs and tenant data protected
- [ ] Off-host backups and clean restore verified
- [ ] Model/tool evaluation baseline recorded
- [ ] Denial/race/SSRF/prompt-injection tests pass
- [ ] Findings have evidence and scope lineage
- [ ] Hybrid mode validated in owned lab
- [ ] Security lead signs pilot acceptance

## 17. Open decisions before coding

1. **Host provider and terms:** provider AUP, virtualization, disk persistence, GPU drivers, supported network policies.
2. **Identity provider:** existing company OIDC vs dedicated Keycloak.
3. **Authorization evidence:** who signs customer scopes and which roles perform independent scope review.
4. **Model:** select by license, B200 support, structured tool-call benchmark, latency and context.
5. **Worker isolation:** microVM capability vs network-disabled containers and lab-only tools.
6. **Backup destination:** independent storage, encryption keys and tested restoration procedure.
7. **Permitted target set:** owned staging and designated lab assets for MVP.
8. **Retention:** contractual evidence/log retention and deletion periods.

**Recommended initial build order:** Milestone 0 → 1 → 2 (offline tools) → 3 (approval/isolated gateway) → 4 → lab pilot. Keep outbound target actions disabled until independent scope, approval, and enforced egress tests succeed.
