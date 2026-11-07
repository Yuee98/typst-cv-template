// Local integration is real Auth/Data API plus the current transactional ledger.
// Paid upstream smoke requires a separate, explicitly budgeted hosted runbook step.
import { runDbTests } from "./run-db-tests.mjs";
process.exitCode = await runDbTests({ env: { ...process.env, DB_TESTS_REQUIRED: "1" } });
