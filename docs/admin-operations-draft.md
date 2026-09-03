# Admin operations draft

Status: FUTURE, not the current hosted runbook. The current DB013 operations remain in [AI Provider Operations](ai-provider-operations.md) until the explicit authority cutover has occurred in that environment.

1. Initialize the Admin environment identity and first member in an authorized DB-owner transaction. Bind an existing confirmed Auth UUID; write db_operator audit. No application bootstrap exists.
2. Read-only deployment checks require the exact project/environment and user JWT. The DB repeats membership/session/account checks; no AI gate is required for administrative reads.
3. Prepare code/build/legal evidence with the owner importer and use the runtime validation producer for factual candidate reports. Browser input supplies only candidate/report IDs.
4. Verify the precise deployed build, JWT/TOTP flow, operator fallback CLI and compatible rollback build before authority cutover. Perform only DB checks/revocations/mode switch in the cutover transaction, then verify real post-cutover operations. Never re-grant old operator bypasses as a rollback shortcut.
5. Create immutable versions, resolve each dependency, then publish with gate-off, expected pointer/generation, audited pointer mutation, trusted readback and separate TOTP reopen. A legal current transition first prepares both forward and rollback tuples under the new bundle.
6. A timed-out synchronous mutation has an unknown result. Keep its key/payload and read/replay that operation; absence of a row is not proof that no operation is in flight.
7. Disable is one-way and remains available without step-up. Account/factor recovery is explicit owner or other valid-admin work. Keep tokens, TOTP enrollment secrets and Provider keys out of console, DB and test artifacts.
8. Hosted migration, new paid calls and release changes require concrete environment-scoped execution evidence and authorization. This draft does not certify any environment ready.
