# Tatvam AI Red Team

An authorized, scope-gated platform for security assessments, security code review, controlled verification and evidence-backed reporting. The MVP runs in Hybrid mode on a single rented GPU host.

Every target-contacting action requires an independently reviewed engagement scope and passes a deterministic policy check. Intrusive actions also need a single-use human approval bound to the exact payload. The MVP has no autonomous exploitation, credential attack, persistence, lateral movement or exfiltration capability.

## Documents

- [Implementation specification](docs/spec/TATVAM_AI_RED_TEAM_IMPLEMENTATION.md)
- [Delivery plan](docs/PLAN.md)
- [Agent and contributor guardrails](CLAUDE.md)

## Status

Bootstrap only. Milestone 0 (scaffold, CI, threat model) is next. See the delivery plan.

## Layout

```text
apps/web/              Next.js dashboard
services/api/app/      FastAPI service: auth, routes, db, policies, agents, tools, workers, evidence, reports
packages/contracts/    OpenAPI-generated TypeScript types
infra/                 compose, vLLM, gateway, monitoring, scripts
tests/                 unit, integration, security, e2e, evaluations
docs/                  spec, plan, ADRs, runbooks, threat model
```
