# Admin draft preparation before runtime activation

Status: implemented by `20260910000000_admin_drafts_before_cutover.sql` and the matching Admin context v3 build. This changes the blanket restriction that all Admin writes require runtime authority cutover. It preserves the existing runtime publication and execution checks.

## User experience

After first-admin bootstrap, an administrator can prepare configuration while AI continues using its current route. Forms remain editable until **Create version** commits a new immutable record. Saving a draft does not select it for execution.

The interface distinguishes **Draft preparation available** from **Runtime changes enabled**. Each operation uses the relevant capability; the interface no longer describes the whole Admin application as read-only merely because runtime cutover has not happened.

| Operation | Available before runtime cutover | Persisted effect |
| --- | --- | --- |
| Edit Provider defaults | Yes | Changes defaults for future versions; frozen execution fields remain unchanged |
| Create profile identity | Yes | Creates an identity with no executable version |
| Create profile version | Yes | Creates an immutable `draft` |
| Create price version | Yes | Creates an immutable, unsealed price |
| Create routing policy draft | Yes | Creates an immutable `draft`, without a validation-report prerequisite |
| Check prepared configuration | Yes, when its target exists | Produces existing configuration evidence; does not activate or transmit user content |
| Seal, promote or retire runtime configuration | No | Keeps existing authority, evidence and step-up checks |
| Change route, AI gate or quota; reopen AI | No | Keeps existing runtime control workflow |
| Change administrator membership | Unchanged | Outside this focused configuration-authoring change |

Provider directory archiving affects future authoring. It is distinct from retiring a profile or version, which remains under runtime-change authority.

## Validation boundaries

Preparation checks authentication, active administrator membership, the current session/account, environment, input shape, supported adapters, credential namespace, endpoint syntax, foreign-key references and concurrency revisions. Every committed write has a reason, idempotency key and audit record. These checks do not require AI to be disabled or an API key to be present in the deployment.

Routing draft creation validates the rules' structure, weekdays, time ranges, overlap, default-route consistency and profile/price references. It does not require current runtime validation reports or promote the referenced versions. Its result and audit describe draft creation, rather than claiming publication evidence.

Existing activation operations continue to require the appropriate current runtime/legal/price evidence, lifecycle state, administrator step-up and concurrency checks. The current owner cutover and AI control cycle remain necessary for actual runtime authority changes. This amendment promises uninterrupted preparation, not an online replacement for that activation workflow.

## Implementation boundary

Expose draft preparation separately from the existing runtime `writes` capability. Remove the runtime-mode prerequisite only from the four existing preparation RPCs: Provider defaults, profile identity, profile version and price creation. Keep the shared authentication/write-actor helper and every runtime mutation gate unchanged.

Add a separate routing-policy draft RPC and typed API operation. Preserve the existing report-bearing policy creation operation and publication results for their current consumers and committed replays. Use a distinct draft result without fabricated lifecycle evidence.

The four preparation RPCs and context reader are outside the runtime receipt's expected-function catalog. The migration must preserve that separation: it changes no tracked runtime definition, runtime grant, receipt, authority epoch, environment/control revision, AI gate, route pointer or configuration generation. The exact test inventory still records the new and changed authoring functions and their ACLs.

Do not mutate historical versions or introduce a second mutable-draft storage system. Existing price-lane exclusion constraints remain; an overlapping price cannot be saved by silently closing or altering a currently used price. Unsealed or not-yet-ready runtime dependencies can be prepared, but required referenced records must exist.

## Acceptance evidence

- With a genuine local Auth administrator, `legacy` mode and AI enabled, save defaults and create profile, price and routing drafts through the protected API. Verify audit/idempotency and expected-version conflict behavior.
- Compare current gate, pointer, generation, control/environment revision, frozen execution facts, runtime expected catalog, receipts and grants before and after preparation. Reserve and start legacy AI work across those writes without Provider transmission.
- Deny non-admin, revoked, unavailable-account, dead-session and wrong-environment callers. Preserve direct-table and anonymous/service-role RPC restrictions.
- Verify direct calls cannot promote, seal, retire, change routing or reopen AI before the existing runtime authority gate; UI hiding is not authorization.
- Exercise upgrades from uninitialized, legacy AI-on and already-JWT predecessor states. Existing JWT runtime manifests and receipts remain identical and valid.
- Exercise actual local browser draft creation before cutover, with runtime controls still disabled. Retain the existing Auth/MFA/membership browser test and publication/runtime DB regression suites.
- Pass the exact current SQL definition/ACL inventory, builds, static-export isolation, unit/type/lint checks and full real-DB CI before delivery.
