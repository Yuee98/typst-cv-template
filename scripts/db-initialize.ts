import { input, jsonQuery, quote, sql } from "./db-common.ts";
const local = process.argv.includes("--local");
if (!local) throw new Error("Hosted initialization must run through db-rebuild resume with durable state, target and maintenance guards");
const name = input("environment", local ? "LOCAL" : undefined);
if (!["LOCAL", "PREVIEW", "PRODUCTION"].includes(name) || local && name !== "LOCAL") throw new Error("Invalid environment");
const user = input("admin-user");
if (!/^[0-9a-f-]{36}$/i.test(user)) throw new Error("Admin user must be a confirmed existing Auth UUID");
// initialize is owner-only and commits environment/current/admin atomically.
sql(`select admin.initialize(${quote(name)},${quote(user)}::uuid);`, local);
const result = jsonQuery("select public.app_context();", local);
sql("select ai.register_jobs();", local);
console.log(JSON.stringify(result));
