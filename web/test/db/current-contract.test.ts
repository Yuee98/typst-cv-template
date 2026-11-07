import { registerClient } from "@/lib/supabase/user-client";
import { execFileSync } from "node:child_process";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCloudCvDocument, listCloudCvDocuments, loadCloudCvDocument, updateCloudCvDocumentData } from "@/lib/cv/cloud-storage";
import { sampleCvDataEn } from "@/lib/cv/sample-data";
const url = process.env.SUPABASE_TEST_URL!;
if (!url || !["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname) || new URL(url).protocol !== "http:") throw new Error("DB tests require explicit HTTP loopback");
const pub = process.env.SUPABASE_TEST_PUBLISHABLE_KEY!;
const admin = createClient(url, process.env.SUPABASE_TEST_SECRET_KEY!, {
  auth: {
    persistSession: false,
    autoRefreshToken: false
  }
});
const createdUsers: string[] = [];
let a: SupabaseClient;
let b: SupabaseClient;
let aUserId: string;
let guard: {
  contract_code: string;
  database_instance_id: string;
};
async function user() {
  const email = `db-${crypto.randomUUID()}@example.test`;
  const password = `Cv-${crypto.randomUUID()}!`;
  const {
    data,
    error
  } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true
  });
  if (error) throw error;
  createdUsers.push(data.user.id);
  const client = createClient(url, pub, {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  });
  registerClient(client, url, pub);
  const signed = await client.auth.signInWithPassword({
    email,
    password
  });
  if (signed.error) throw signed.error;
  return client;
}
async function acceptTerms(client: SupabaseClient) {
  const {
    data,
    error
  } = await client.rpc("legal_current");
  if (error) throw error;
  const identity = await client.auth.getUser();
  const result = await client.rpc("legal_accept_document", {
    p_input: {
      ...guard,
      expected_auth_user_id: identity.data.user!.id,
      document_version_id: data.terms.external_id,
      content_digest: data.terms.content_digest
    }
  });
  if (result.error) throw result.error;
}
beforeAll(async () => {
  a = await user();
  aUserId = (await a.auth.getUser()).data.user!.id;
  b = await user();
  const {
    data,
    error
  } = await a.rpc("app_context");
  if (error) throw error;
  if (!data.ready) {
    const identity = await a.auth.getUser();
    const id = identity.data.user!.id;
    execFileSync("docker", ["exec", "-i", "supabase_db_typst-cv-template", "psql", "-XAt", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres"], {
      input: `select admin.initialize('LOCAL','${id}'::uuid);`,
      stdio: ["pipe", "pipe", "pipe"]
    });
    const initialized = await a.rpc("app_context");
    if (initialized.error) throw initialized.error;
    Object.assign(data, initialized.data);
  }
  guard = {
    contract_code: data.contract_code,
    database_instance_id: data.database_instance_id
  };
  await acceptTerms(a);
  await acceptTerms(b);
});
afterAll(async () => {
  // This owner-only fixture teardown precedes Auth deletion; production callers
  // must revoke an active membership through the authorized Admin transaction.
  if (createdUsers.length) {
    const ids = createdUsers.map(id => {
      if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("Invalid fixture user ID");
      return `'${id}'::uuid`;
    }).join(",");
    execFileSync("docker", ["exec", "-i", "supabase_db_typst-cv-template", "psql", "-XAt", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres"], { input: `update admin.members set time_revoked=clock_timestamp(),user_updated=null where auth_user_id in (${ids}) and time_revoked is null;`, stdio: ["pipe", "pipe", "pipe"] });
  }
  for (const id of createdUsers) {
    const { error } = await admin.auth.admin.deleteUser(id);
    if (error) throw error;
  }
});

describe("current database through real Auth and Data API", () => {
  it("requires the current terms before storing cloud content", async () => {
    const client = await user();
    const expectedUserId = (await client.auth.getUser()).data.user!.id;
    await expect(createCloudCvDocument(client, {
      title: "No consent",
      expectedUserId,
      data: sampleCvDataEn
    })).rejects.toBeTruthy();
    await acceptTerms(client);
    await expect(createCloudCvDocument(client, {
      title: "Consent",
      expectedUserId,
      data: sampleCvDataEn
    })).resolves.toMatchObject({
      title: "Consent"
    });
  });
  it("uses private tables and read-only user views", async () => {
    const {
      error
    } = await a.from("cv_document_summaries").insert({
      title: "cannot write"
    });
    expect(error).not.toBeNull();
    expect((await a.from("cv_documents").select("*")).error).not.toBeNull();
    expect((await a.schema("cv").from("documents").select("*")).error).not.toBeNull();
  });
  it("round trips current CVs and isolates two users", async () => {
    const doc = await createCloudCvDocument(a, {
      title: "Current CV",
      expectedUserId: aUserId,
      data: sampleCvDataEn
    });
    expect(doc.id).toMatch(/^cv_[0-9A-HJKMNP-TV-Z]{12}$/);
    expect((await listCloudCvDocuments(b)).find(row => row.id === doc.id)).toBeUndefined();
    await expect(loadCloudCvDocument(b, doc.id)).rejects.toThrow();
    expect((await loadCloudCvDocument(a, doc.id)).data).toEqual(sampleCvDataEn);
    const changed = {
      ...sampleCvDataEn,
      header: {
        ...sampleCvDataEn.header,
        name: "Changed"
      }
    };
    expect((await updateCloudCvDocumentData(a, doc.id, changed, aUserId)).data.header.name).toBe("Changed");
  });
  it("has one winner for concurrent writes at the same revision", async () => {
    const doc = await createCloudCvDocument(a, {
      title: "Concurrent",
      expectedUserId: aUserId,
      data: sampleCvDataEn
    });
    const identity = await a.auth.getUser();
    const input = {
      ...guard,
      expected_auth_user_id: identity.data.user!.id,
      external_id: doc.id,
      expected_revision: "1",
      title: "One winner"
    };
    const writes = await Promise.all([a.rpc("cv_document_rename", {
      p_input: input
    }), a.rpc("cv_document_rename", {
      p_input: input
    })]);
    expect(writes.filter(result => !result.error)).toHaveLength(1);
    expect(writes.filter(result => result.error?.message === "CONFLICT")).toHaveLength(1);
  });
  it.each([5, 6, 8, undefined])("rejects plaintext version %s even when directly invoking RPC", async version => {
    const identity = await a.auth.getUser();
    const {
      error
    } = await a.rpc("cv_document_create", {
      p_input: {
        ...guard,
        expected_auth_user_id: identity.data.user!.id,
        client_create_key: crypto.randomUUID(),
        title: "Rejected",
        storage_mode: "PLAIN",
        document_schema_version: 7,
        data: {
          ...sampleCvDataEn,
          schemaVersion: version
        }
      }
    });
    expect(error).not.toBeNull();
  });
  it("rejects old instance writes and anonymous/service-role client writes", async () => {
    const identity = await a.auth.getUser();
    const input = {
      ...guard,
      expected_auth_user_id: identity.data.user!.id,
      database_instance_id: crypto.randomUUID(),
      client_create_key: crypto.randomUUID(),
      title: "Rejected",
      storage_mode: "PLAIN",
      document_schema_version: 7,
      data: sampleCvDataEn
    };
    expect((await a.rpc("cv_document_create", {
      p_input: input
    })).error).not.toBeNull();
    const anon = createClient(url, pub, {
      auth: {
        persistSession: false
      }
    });
    expect((await anon.rpc("cv_document_create", {
      p_input: {
        ...input,
        ...guard
      }
    })).error).not.toBeNull();
    expect((await admin.rpc("cv_document_create", {
      p_input: {
        ...input,
        ...guard
      }
    })).error).not.toBeNull();
  });
});
