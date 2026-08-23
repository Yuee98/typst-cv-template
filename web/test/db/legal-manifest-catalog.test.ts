import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import { RUN_DB_TESTS } from "./helpers";

const DATABASE_CONTAINER = "supabase_db_typst-cv-template";

const EXPECT_SQLSTATE_HELPER = String.raw`
  create function pg_temp.expect_sqlstate(expected_state text, statement text)
  returns void
  language plpgsql
  as $function$
  begin
    begin
      execute statement;
    exception when others then
      if sqlstate = expected_state then
        return;
      end if;
      raise;
    end;
    raise exception 'statement unexpectedly succeeded: %', statement;
  end;
  $function$;
`;

function runRollbackFixture(sql: string): string {
  const script = String.raw`
    \set ON_ERROR_STOP on
    begin;
    ${EXPECT_SQLSTATE_HELPER}
    ${sql}
    rollback;
  `;
  const result = spawnSync(
    "docker",
    [
      "exec",
      "-i",
      DATABASE_CONTAINER,
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "--set",
      "ON_ERROR_STOP=1",
    ],
    { input: script, encoding: "utf8" },
  );

  if (result.status !== 0) {
    throw new Error(
      `database-owner rollback fixture failed: ${result.stderr || result.stdout}`,
    );
  }
  return result.stdout;
}

describe.skipIf(!RUN_DB_TESTS)("immutable legal manifest catalog (real DB)", () => {
  it("rejects missing membership, ID rebinds, and composite-pair mismatches", () => {
    const output = runRollbackFixture(String.raw`
      insert into public.ai_legal_bundle_versions (
        legal_bundle_version,
        bundle_contract_sha256,
        manifest_set_sha256
      ) values (
        'missing-catalog-bundle-v1',
        repeat('a', 64),
        repeat('b', 64)
      );

      select pg_temp.expect_sqlstate(
        '23503',
        $statement$
          insert into public.ai_legal_bundle_manifests (
            legal_bundle_version,
            legal_manifest_id,
            manifest_sha256
          ) values (
            'missing-catalog-bundle-v1',
            'missing-manifest-v1',
            repeat('1', 64)
          )
        $statement$
      );

      insert into public.ai_legal_manifest_versions (
        legal_manifest_id,
        manifest_sha256
      ) values
        ('pair-a-v1', repeat('1', 64)),
        ('pair-b-v1', repeat('2', 64));

      select pg_temp.expect_sqlstate(
        '23505',
        $statement$
          insert into public.ai_legal_manifest_versions (
            legal_manifest_id,
            manifest_sha256
          ) values ('pair-a-v1', repeat('3', 64))
        $statement$
      );

      select pg_temp.expect_sqlstate(
        '23503',
        $statement$
          insert into public.ai_legal_bundle_manifests (
            legal_bundle_version,
            legal_manifest_id,
            manifest_sha256
          ) values (
            'missing-catalog-bundle-v1',
            'pair-a-v1',
            repeat('2', 64)
          )
        $statement$
      );

      select 'catalog-pair-adversarial-ok';
    `);
    expect(output).toContain("catalog-pair-adversarial-ok");
  });

  it("enforces ASCII code IDs and lowercase SHA-256 values at every boundary", () => {
    const output = runRollbackFixture(String.raw`
      insert into public.ai_legal_bundle_versions (
        legal_bundle_version,
        bundle_contract_sha256,
        manifest_set_sha256
      ) values (
        'valid-bundle-v1',
        repeat('a', 64),
        repeat('b', 64)
      );

      select pg_temp.expect_sqlstate(
        '23514',
        $statement$
          insert into public.ai_legal_manifest_versions (
            legal_manifest_id,
            manifest_sha256
          ) values ('清单-v1', repeat('1', 64))
        $statement$
      );
      select pg_temp.expect_sqlstate(
        '23514',
        $statement$
          insert into public.ai_legal_manifest_versions (
            legal_manifest_id,
            manifest_sha256
          ) values ('Uppercase-v1', repeat('1', 64))
        $statement$
      );
      select pg_temp.expect_sqlstate(
        '23514',
        $statement$
          insert into public.ai_legal_manifest_versions (
            legal_manifest_id,
            manifest_sha256
          ) values ('a' || repeat('b', 200), repeat('1', 64))
        $statement$
      );
      select pg_temp.expect_sqlstate(
        '23514',
        $statement$
          insert into public.ai_legal_manifest_versions (
            legal_manifest_id,
            manifest_sha256
          ) values ('valid-manifest-v1', repeat('A', 64))
        $statement$
      );
      select pg_temp.expect_sqlstate(
        '23514',
        $statement$
          insert into public.ai_legal_manifest_versions (
            legal_manifest_id,
            manifest_sha256
          ) values ('valid-manifest-v1', repeat('1', 63))
        $statement$
      );
      select pg_temp.expect_sqlstate(
        '23514',
        $statement$
          insert into public.ai_legal_bundle_versions (
            legal_bundle_version,
            bundle_contract_sha256,
            manifest_set_sha256
          ) values ('bundle-版本-v1', repeat('a', 64), repeat('b', 64))
        $statement$
      );
      select pg_temp.expect_sqlstate(
        '23514',
        $statement$
          insert into public.ai_legal_bundle_manifests (
            legal_bundle_version,
            legal_manifest_id,
            manifest_sha256
          ) values ('valid-bundle-v1', 'child-清单-v1', repeat('1', 64))
        $statement$
      );
      select pg_temp.expect_sqlstate(
        '23514',
        $statement$
          insert into public.ai_legal_bundle_manifests (
            legal_bundle_version,
            legal_manifest_id,
            manifest_sha256
          ) values ('valid-bundle-v1', 'valid-child-v1', repeat('F', 64))
        $statement$
      );

      select 'catalog-shape-adversarial-ok';
    `);
    expect(output).toContain("catalog-shape-adversarial-ok");
  });

  it("keeps catalog rows immutable and allows exact-pair reuse across bundles", () => {
    const output = runRollbackFixture(String.raw`
      set local role service_role;

      insert into public.ai_legal_manifest_versions (
        legal_manifest_id,
        manifest_sha256
      ) values ('shared-manifest-v1', repeat('1', 64));

      insert into public.ai_legal_bundle_versions (
        legal_bundle_version,
        bundle_contract_sha256,
        manifest_set_sha256
      ) values
        (
          'shared-bundle-a-v1',
          repeat('a', 64),
          encode(
            extensions.digest(
              convert_to(
                octet_length(convert_to('shared-manifest-v1', 'UTF8'))::text
                  || ':shared-manifest-v1:' || repeat('1', 64),
                'UTF8'
              ),
              'sha256'
            ),
            'hex'
          )
        ),
        (
          'shared-bundle-b-v1',
          repeat('b', 64),
          encode(
            extensions.digest(
              convert_to(
                octet_length(convert_to('shared-manifest-v1', 'UTF8'))::text
                  || ':shared-manifest-v1:' || repeat('1', 64),
                'UTF8'
              ),
              'sha256'
            ),
            'hex'
          )
        );

      insert into public.ai_legal_bundle_manifests (
        legal_bundle_version,
        legal_manifest_id,
        manifest_sha256
      ) values
        ('shared-bundle-a-v1', 'shared-manifest-v1', repeat('1', 64)),
        ('shared-bundle-b-v1', 'shared-manifest-v1', repeat('1', 64));

      update public.ai_legal_bundle_versions
      set sealed_at = greatest(clock_timestamp(), created_at)
      where legal_bundle_version = 'shared-bundle-a-v1';

      select pg_temp.expect_sqlstate(
        '23514',
        $statement$
          update public.ai_legal_manifest_versions
          set manifest_sha256 = repeat('2', 64)
          where legal_manifest_id = 'shared-manifest-v1'
        $statement$
      );
      select pg_temp.expect_sqlstate(
        '23514',
        $statement$
          delete from public.ai_legal_manifest_versions
          where legal_manifest_id = 'shared-manifest-v1'
        $statement$
      );

      reset role;

      do $assertions$
      begin
        if (select count(*) from public.ai_legal_bundle_manifests
            where legal_manifest_id = 'shared-manifest-v1') <> 2 then
          raise exception 'exact manifest pair was not reused by both bundles';
        end if;
        if (select sealed_at is null from public.ai_legal_bundle_versions
            where legal_bundle_version = 'shared-bundle-a-v1') then
          raise exception 'first reusable bundle did not seal';
        end if;
        if not (select sealed_at is null from public.ai_legal_bundle_versions
                where legal_bundle_version = 'shared-bundle-b-v1') then
          raise exception 'second reusable bundle did not remain draft';
        end if;
      end;
      $assertions$;

      select 'catalog-reuse-seal-ok';
    `);
    expect(output).toContain("catalog-reuse-seal-ok");
  });

  it("keeps RLS and role grants closed to public callers without a registration RPC", () => {
    const output = runRollbackFixture(String.raw`
      do $assertions$
      declare
        role_name text;
        privilege_name text;
      begin
        if not (select relrowsecurity from pg_catalog.pg_class
                where oid = 'public.ai_legal_manifest_versions'::regclass) then
          raise exception 'catalog RLS is not enabled';
        end if;
        if not (select relrowsecurity from pg_catalog.pg_class
                where oid = 'public.ai_legal_bundle_manifests'::regclass) then
          raise exception 'bundle-child RLS is not enabled';
        end if;

        foreach role_name in array array['anon', 'authenticated'] loop
          foreach privilege_name in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE'] loop
            if has_table_privilege(
              role_name,
              'public.ai_legal_manifest_versions',
              privilege_name
            ) then
              raise exception '% unexpectedly has % on manifest catalog',
                role_name, privilege_name;
            end if;
            if has_table_privilege(
              role_name,
              'public.ai_legal_bundle_manifests',
              privilege_name
            ) then
              raise exception '% unexpectedly has % on bundle children',
                role_name, privilege_name;
            end if;
          end loop;
        end loop;

        foreach privilege_name in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE'] loop
          if not has_table_privilege(
            'service_role',
            'public.ai_legal_manifest_versions',
            privilege_name
          ) then
            raise exception 'service_role lacks catalog % during dark-stack authoring',
              privilege_name;
          end if;
          if not has_table_privilege(
            'service_role',
            'public.ai_legal_bundle_manifests',
            privilege_name
          ) then
            raise exception 'service_role lacks child % during dark-stack authoring',
              privilege_name;
          end if;
        end loop;

        if exists (
          select 1
          from pg_catalog.pg_proc procedure
          join pg_catalog.pg_namespace namespace
            on namespace.oid = procedure.pronamespace
          where namespace.nspname = 'public'
            and procedure.proname like 'register_ai_legal%'
        ) then
          raise exception 'generic legal registration function is exposed';
        end if;
      end;
      $assertions$;

      set local role anon;
      select pg_temp.expect_sqlstate(
        '42501',
        $statement$select * from public.ai_legal_manifest_versions limit 1$statement$
      );
      select pg_temp.expect_sqlstate(
        '42501',
        $statement$
          insert into public.ai_legal_manifest_versions (
            legal_manifest_id,
            manifest_sha256
          ) values ('anon-manifest-v1', repeat('1', 64))
        $statement$
      );
      reset role;

      set local role authenticated;
      select pg_temp.expect_sqlstate(
        '42501',
        $statement$select * from public.ai_legal_bundle_manifests limit 1$statement$
      );
      select pg_temp.expect_sqlstate(
        '42501',
        $statement$
          insert into public.ai_legal_bundle_manifests (
            legal_bundle_version,
            legal_manifest_id,
            manifest_sha256
          ) values ('forbidden-v1', 'forbidden-v1', repeat('1', 64))
        $statement$
      );
      reset role;

      select 'catalog-role-gate-ok';
    `);
    expect(output).toContain("catalog-role-gate-ok");
  });
});
