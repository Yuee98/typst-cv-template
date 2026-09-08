import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createServiceClient,
  getLedgerRow,
  RUN_DB_TESTS,
  type TestUser,
} from "./helpers";
import { runOwnerSql } from "./runtime-contract-fixtures";
import { SettlementHarness } from "./provider-attempt-settlement-fixtures";

describe.skipIf(!RUN_DB_TESTS)(
  "CFG-005 legacy V1 execution through V5 (real DB)",
  () => {
    let service: SupabaseClient;
    let harness: SettlementHarness;
    let user: TestUser;

    beforeAll(async () => {
      service = createServiceClient();

      // This regression specifically covers the migration state before Admin
      // bootstrap and before a control-plane cutover. Do not manufacture an
      // Admin identity: V1 must remain executable without one.
      const environmentCount = runOwnerSql(
        "select count(*) from public.admin_environment;",
      ).stdout.match(/\n\s*(\d+)\s*\n/u)?.[1];
      expect(environmentCount).toBe("0");

      // The fixture creates a route with the historical
      // profile_execution_config_v1 binding, then reserves it through the
      // V2 reservation API. This is distinct from the original bare reserve
      // API, whose historical rows have no frozen execution route at all.
      harness = new SettlementHarness(service);
      await harness.setup();
      user = await harness.makeUser("cfg005-legacy-v1-upgrade");
    });

    afterAll(async () => {
      if (harness) {
        await harness.cleanup();
      }
    });

    it("starts a legacy reservation through V5 without a receipt or Admin bootstrap", async () => {
      const reservation = await harness.reserveV2(user);

      const reservedRequest = await getLedgerRow(
        service,
        reservation.reservationId,
      );
      expect(reservedRequest).toMatchObject({
        reservation_id: reservation.reservationId,
        user_id: user.id,
        state: "reserved",
        attempt_count: 0,
        route_schema_version: "route_snapshot_v1",
        profile_version_id: reservation.routeSnapshot.profileVersionId,
        price_version_id: reservation.routeSnapshot.priceVersionId,
      });
      const reservedProfile = await service
        .from("ai_provider_profile_versions")
        .select("execution_schema_version")
        .eq("id", reservation.routeSnapshot.profileVersionId)
        .single();
      expect(reservedProfile.error).toBeNull();
      expect(reservedProfile.data).toEqual({
        execution_schema_version: "profile_execution_config_v1",
      });

      const snapshot = await service.rpc("get_ai_polish_execution_snapshot_v5", {
        p_reservation_id: reservation.reservationId,
        p_user_id: user.id,
        p_environment: "local",
        p_project_ref: "local",
      });
      expect(snapshot.error).toBeNull();
      expect(snapshot.data).toMatchObject({
        schemaVersion: "ai_polish_execution_snapshot_v1",
        ok: true,
        reservationId: reservation.reservationId,
      });
      expect(snapshot.data).not.toHaveProperty("runtimeConfigReceipt");

      const started = await service.rpc("start_ai_polish_provider_attempt_v5", {
        p_reservation_id: reservation.reservationId,
        p_attempt_no: 1,
        p_runtime_config_receipt: null,
      });
      expect(started.error).toBeNull();
      expect(started.data).toMatchObject({
        ok: true,
        attemptNo: 1,
        alreadyStarted: false,
        status: "started",
      });

      const request = await getLedgerRow(service, reservation.reservationId);
      expect(request).toMatchObject({
        reservation_id: reservation.reservationId,
        user_id: user.id,
        state: "reserved",
        attempt_count: 1,
      });

      const attempt = await service
        .from("ai_provider_attempt_ledger")
        .select(
          "reservation_id,attempt_no,status,execution_schema_version,endpoint_url,credential_env_name,runtime_build_id,binding_manifest_revision",
        )
        .eq("attempt_id", started.data!.attemptId)
        .single();
      expect(attempt.error).toBeNull();
      expect(attempt.data).toEqual({
        reservation_id: reservation.reservationId,
        attempt_no: 1,
        status: "started",
        execution_schema_version: "profile_execution_config_v1",
        endpoint_url: null,
        credential_env_name: null,
        runtime_build_id: null,
        binding_manifest_revision: null,
      });
    });
  },
);
