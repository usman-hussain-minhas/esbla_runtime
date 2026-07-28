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

T3-3 versions each tenant surface base independently, keeps personal overlays
bound to an exact base, applies CAS to base and overlay writes, records evidence
and preserves the code-owned definition boundary. The database stores only
validated declarative identity, geometry and version facts.

T3-4 resolves every authorized persisted placement into deterministic desktop,
tablet and phone layouts. Desktop preserves valid personal geometry. Each
code-owned surface definition version now persists its exact eight-column
tablet base and four-column phone base, so those initial bases are not
recalculated per request. Invalid geometry and duplicate identity fail closed,
while clamps, collisions, unsupported breakpoints and unpositioned content
produce explicit diagnostics. Breakpoint-specific tenant/user editing remains
outside this kernel slice.

The same slice provides a bounded provider host that skips ineligible providers,
caps concurrency, applies per-provider timeouts and aborts only the affected
read. A provider loader must cooperatively settle after abort; its slot is not
released and host settlement is not claimed before that join. Provider failures
settle independently; only an explicitly classified shared-substrate failure
or timeout can fail the host, selected in registration order after every
provider settles. Product rendering receives sanitized state models, never raw
provider errors.

One shared widget frame now renders the complete state grammar: idle, loading,
populated, empty, unavailable, operational error, permission denied, service
inactive, not found and stale/retrying. The real Leave widget remains the live
consumer and keeps its no-store policy, so it does not claim stale-cache
behavior.

T4-1 adds read-only, tenant-scoped navigation discovery. Service Groups and
contextual destinations are derived only from current service activation,
current membership roles and exact current capabilities. Ineligible services
are not loaded merely to decide navigation visibility, and a context with no
meaningful alternative omits its launcher and gap.

T4-2 gives all current Zen floating chrome one state owner. Direct navigation,
User/System and Appearance therefore arbitrate instead of stacking. Desktop
keeps its corner grammar; tablet and phone use the exact 1100/768 Product
boundaries. A pure resolver measures the available inline size, rendered square
control size, gaps and safe-area insets. It contains lower-priority controls in
System deterministically, with phone Appearance always contained and
Service Groups collapsing before Current Page. When resizing removes a direct
launcher, its open navigation or Appearance surface moves into the equivalent
System view with a valid focus and restore target. Collapsed navigation remains
a readable, keyboard-reachable System entry. Search, Notifications, Team, tenant
switching, status, Universal Settings and Edit Surface remain absent until
backed.

T4-3 registers ordered semantic sections separately from user layout geometry
and binds them to the exact code-owned surface base version, definition hash and
canonical contract. A section becomes eligible only after an exact registered
widget instance or authorized content anchor survives activation and
authorization filtering.
Both initial Mission Control surfaces deliberately retain one `overview`
section, so they reserve no rail geometry and render no rail control. The shared
rail renders only when at least two sections survive, uses the one surface
scroll owner and actual heading intersections, moves focus to an unobscured
selected heading without rewriting history, preserves named keyboard controls
and the v3.2 desktop bar/tooltip grammar, and uses a readable contained chooser
on tablet and phone. A later
versioned multi-section surface supplies the first visible Product consumer;
this slice does not fabricate a second default section merely to demonstrate
the rail.

## Requirement trace

| ID | Runtime implementation | Proof in this walking slice |
|---|---|---|
| `ZEN-ID-001` | `identity.ts`, Runtime Theme registry, alias resolver and canonical CSS identity | registry/source tests and startup |
| `ZEN-NAV-001` | `/` renders `surface.mission-control` | browser navigation |
| `ZEN-NAV-002` | service-group navigation requires fresh activation plus a current code-owned domain read capability from any included HR service; widget placement separately requires the exact widget capabilities | integration and browser denial, including action-only absence |
| `ZEN-NAV-003` | a contextual launcher exists only when at least one meaningful alternate destination remains | unit/browser |
| `ZEN-NAV-004` | persistent navigation and service controls use the closed semantic icon registry | manifest/static |
| `ZEN-PANEL-001` | one shared state owner arbitrates direct navigation, System, collapsed navigation and Appearance; Escape unwinds nested System content before the containing panel | keyboard/browser |
| `ZEN-PANEL-002` | the Theme launcher opens the shared Appearance panel and never changes preference implicitly | browser |
| `ZEN-RESP-001` | 12-column desktop, 8-column tablet and 4-column phone grammar at the exact 1100/768 boundaries, with safe-area chrome and persistent User/System | source and browser boundary checks |
| `ZEN-RESP-002` | a pure resolver uses measured control geometry and deterministic tablet/phone collapse priority; collapsed navigation remains available in System | unit/browser |
| `ZEN-SURF-001` | shared code-owned version-one surface manifests and ordered default-instance metadata, startup hash/binding validation, plus tenant-scoped personal overlays with CAS | contract, platform-core, database integration, reload and restart proof |
| `ZEN-SURF-002` | a pure bounded resolver derives stable 12/8/4 geometry, clamps declared constraints, rejects invalid/duplicate identity, resolves collisions without overlap and returns explicit diagnostics | unit and browser boundary/geometry checks |
| `ZEN-SURF-003` | code-owned ordered semantic sections require an eligible widget or authorized content anchor; one-section defaults omit all rail markup; the shared rail uses actual section intersections, the one scroll owner, keyboard controls, focus movement, desktop bar/tooltip grammar and a compact tablet/phone chooser without history mutation | resolver/component proof and actual-browser default-absence proof; visible multi-section browser proof remains for the first versioned multi-section surface |
| `ZEN-WIDGET-001` | generic immutable widget-manifest registry with exact `hr.leave.my-requests` V1 semantics, layout metadata, startup hash/binding validation and a closed semantic-icon resolver; PostgreSQL stores no executable definition | contract/unit/schema checks |
| `ZEN-WIDGET-002` | shared components deliberately render all ten registered states; the real Leave provider uses loading, empty, populated and sanitized denied/inactive/not-found/error/unavailable states while stale remains inapplicable under `no_store` | component proof for all states; real-provider browser proof for populated/responsive rendering only; browser proof for every failure state is not claimed |
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

This trace describes the T2 walking slice, all four bounded T3 generalizations
and the first three T4 shell slices. It proves the current composition kernel,
capability-safe navigation, responsive panel arbitration and the truthful
section-rail contract; it does not claim registered shortcuts, a visible
multi-section Product surface, Studio, the complete Zen shell, complete HR,
release or deployment.
