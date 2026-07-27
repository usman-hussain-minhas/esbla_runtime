# Zen Theme v1 implementation

This directory implements the public Runtime side of the ratified Zen composition
contract. Product definitions remain code-owned; the database stores only bounded
tenant or user values and layout patches.

The source prototype does not contain licensed font files. Runtime therefore uses
the accepted system-font fallback stack and does not fetch a network font.

Current T2 walking slice:

- `surface.mission-control`
- `surface.hr.mission-control`
- `hr.leave.my-requests`
- `appearance.palette.v1`
- `appearance.high_contrast.v1`
- distinct version-one tenant surface bases and own-user overlays
- capability-gated User/System plus direct Theme launchers, with Theme contained
  inside System on phone
- a closed semantic-icon registry with an explicit generic-service fallback
- intercepted route-backed Leave detail overlay with the same canonical
  standalone route and canonical-host return

The server is authoritative for appearance and layout. Browser storage is only
an appearance hydration cache. Surface writes use tenant scope, current
membership, exact own-layout policy, strict registry validation, CAS, evidence
and explicit `non_billable` treatment. Surface reads are side-effect-free; the
two code-owned bases are materialized atomically with the first personal layout
mutation. No executable definition is stored in PostgreSQL.

High contrast is an independent accessibility overlay, never a third palette.

T3-1 generalizes the proven appearance seam into an immutable eleven-key
presentation-setting registry and pure deterministic resolver. The existing
server-rendered palette/high-contrast path is its first live consumer. This
slice does not generalize persistence: server-authoritative storage, CAS and the
Settings face remain later T3/T6 work.

T3-2 moves the two proven surfaces, their ordered default-instance metadata and
the Leave widget into shared, deeply immutable code-manifest registries. Generic
schema/binding validation and server-startup canonical-hash checks fail closed;
the Zen web consumer derives its definitions from those registries instead of
duplicating them. This slice deliberately registers no unimplemented HR face
and stores no executable manifest in PostgreSQL.

## Requirement trace

| ID | Runtime implementation | Proof in this walking slice |
|---|---|---|
| `ZEN-ID-001` | `identity.ts`, Runtime Theme registry, alias resolver and canonical CSS identity | registry/source tests and startup |
| `ZEN-NAV-001` | `/` renders `surface.mission-control` | browser navigation |
| `ZEN-NAV-002` | service-group navigation requires fresh activation plus a current code-owned domain read capability from any included HR service; widget placement separately requires the exact widget capabilities | integration and browser denial, including action-only absence |
| `ZEN-RESP-001` | 12-column desktop, 8-column tablet and 4-column phone grammar at the exact 1100/768 boundaries, with safe-area chrome and persistent User/System | source and browser boundary checks |
| `ZEN-SURF-001` | shared code-owned version-one surface manifests and ordered default-instance metadata, startup hash/binding validation, plus tenant-scoped personal overlays with CAS | contract, platform-core, database integration, reload and restart proof |
| `ZEN-WIDGET-001` | generic immutable widget-manifest registry with exact `hr.leave.my-requests` V1 semantics, layout metadata, startup hash/binding validation and a closed semantic-icon resolver; PostgreSQL stores no executable definition | contract/unit/schema checks |
| `ZEN-WIDGET-002` | real Leave provider renders loading, empty, populated and sanitized failure states | unit and browser |
| `ZEN-FULL-001` | parallel intercepted detail route and direct standalone detail route share one face; direct entry returns to the canonical Leave host | browser navigation, direct load and reload |
| `ZEN-FULL-002` | overlay owns scroll, traps focus, conceals the shell and restores origin focus | keyboard/browser |
| `ZEN-SET-001` | HR business settings remain owned by the separate HR service resolver and are not presentation values | source-boundary audit |
| `ZEN-SET-002` | code-owned immutable manifests define the exact eleven V1 presentation keys, scopes, types, constraints, permissions, non-billable treatment, migrations and canonical hashes; the pure resolver enforces exact priority, floors, locks, ordered patches, safe fallback, tombstones and deterministic diagnostics | contract and platform-core unit tests plus startup registry validation |
| `ZEN-SET-003` | server-resolved palette and independent contrast reach the initial document and render correctly with client JavaScript disabled | raw SSR plus no-JavaScript first-paint screenshot and hydrated browser proof |
| `ZEN-SEC-001` | current tenant membership, exact capabilities and service activation are checked on discovery and mutation | integration and browser denial |
| `ZEN-SEC-002` | preference/layout mutations are tenant scoped, CAS-bound, evidenced and explicitly non-billable | integration/SQL |
| `ZEN-REL-001` | authoritative preference and layout survive reload plus actual application and database process restarts | restart integration/browser |
| `ZEN-PROOF-001` | source, unit, integration, browser and visual evidence remain separately labelled | exact-head audit |
| `ZEN-PROCESS-001` | the real Leave consumer precedes kernel generalization; restart proof reuses bounded existing fixtures | candidate audit |

This trace describes the T2 walking slice and the bounded T3-1/T3-2
registry generalizations. It does not claim generalized presentation
persistence, the complete composition kernel, Studio, the complete Zen shell,
complete HR, release or deployment.
