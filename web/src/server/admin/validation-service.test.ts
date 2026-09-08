import { describe, expect, it, vi } from "vitest";
import { produceAdminValidationReport } from "./validation-service";
import { candidate, environment } from "./config-validation-fixtures";

const input = { runtimeContractId: candidate.runtimeTarget.runtimeContractId, runtimeTargetId: candidate.runtimeTarget.runtimeTargetId };
function report(checkOverrides: Record<string, boolean> = {}) {
 const checkedAt = new Date(Date.now() - 1_000);
 const target = Object.fromEntries(Object.entries(candidate.runtimeTarget).filter(([key]) => key !== "recipientKey"));
 const checks = { endpointPolicy: true, credentialBinding: true, credentialConfigured: true, compiledCapability: true, databaseBinding: true, ...checkOverrides };
 return {
  schemaVersion: "admin_config_validation_report_v2", reportId: "55555555-5555-4555-8555-555555555555",
  environment: "local", projectRef: "local", ...target, checks, passed: Object.values(checks).every(Boolean),
  evidenceIds: ["evidence.runtime-target"], checkedAt: checkedAt.toISOString(), expiresAt: new Date(checkedAt.getTime()+9*60_000).toISOString(), reportSha256: "b".repeat(64),
 };
}
function setup(data: unknown = report(), config: unknown = candidate) {
 const rpc = vi.fn().mockResolvedValueOnce({data: config, error: null}).mockResolvedValueOnce({data, error: null});
 return {rpc, client:{rpc}};
}
describe("configuration validation without deployment registration", () => {
 it("validates with only environment identity and Provider credentials", async () => {
  const {rpc,client}=setup();
  const result=await produceAdminValidationReport(input,{environment,client});
  expect(result.passed).toBe(true);
  expect(rpc.mock.calls[0]).toEqual(["get_admin_config_validation_candidate_v2",{p_runtime_contract_id:input.runtimeContractId,p_runtime_target_id:input.runtimeTargetId}]);
  expect(rpc.mock.calls[1][0]).toBe("record_admin_config_validation_report_v2");
  expect(rpc.mock.calls[1][1]).toMatchObject({p_credential_binding_valid:true,p_credential_configured:true});
  expect(JSON.stringify(rpc.mock.calls)).not.toContain("secret-value");
  expect(JSON.stringify(rpc.mock.calls)).not.toMatch(/build|manifest|deployment/i);
 });
 it("reports a missing key without revealing a secret",async()=>{
  const {rpc,client}=setup(report({credentialConfigured:false}));
  const result=await produceAdminValidationReport(input,{environment:{...environment,AI_PROVIDER_KEY_DEEPSEEK_PRIMARY:undefined},client});
  expect(result.passed).toBe(false);
  expect(rpc.mock.calls[1][1]).toMatchObject({p_credential_configured:false});
 });
 it.each([
  ["recipient",{...candidate,runtimeTarget:{...candidate.runtimeTarget,recipientKey:"xiaomi-mimo"}}],
  ["credential prefix",{...candidate,profileExecutionConfig:{...candidate.profileExecutionConfig,credentialEnvName:"AI_PROVIDER_KEY_MIMO_PRIMARY"}}],
 ])("records a failed cross-provider %s check",async(_name,config)=>{
  const {client}=setup(report({credentialBinding:false}),config);
  const result=await produceAdminValidationReport(input,{environment:{...environment,AI_PROVIDER_KEY_MIMO_PRIMARY:"other-key"},client});
  expect(result.checks.credentialBinding).toBe(false);
 });
 it.each([
  ["environment",{...candidate,environment:"preview"}],
  ["project",{...candidate,projectRef:"other"}],
  ["target",{...candidate,runtimeTarget:{...candidate.runtimeTarget,runtimeTargetId:"other-target"}}],
  ["unknown input",{...candidate,unexpected:"value"}],
 ])("rejects crossed candidate %s before recording",async(_name,config)=>{
  const {rpc,client}=setup(report(),config);
  await expect(produceAdminValidationReport(input,{environment,client})).rejects.toThrow();
  expect(rpc).toHaveBeenCalledTimes(1);
 });
 it("does not accept a successful report when this build lacks the capability",async()=>{
  const {client}=setup(report(),{...candidate,runtimeTarget:{...candidate.runtimeTarget,codeCapabilityId:"unknown"}});
  await expect(produceAdminValidationReport(input,{environment,client})).rejects.toThrow();
 });
 it.each([
  {profileVersionId:"99999999-9999-4999-8999-999999999999"},
  {expiresAt:new Date(Date.now()-1_000).toISOString()},
  {checkedAt:new Date(Date.now()+60_000).toISOString(),expiresAt:new Date(Date.now()+120_000).toISOString()},
  {credential:"must-not-leak"},
 ])("rejects mismatched, stale and extra report facts",async(patch)=>{
  const {client}=setup({...report(),...patch});
  await expect(produceAdminValidationReport(input,{environment,client})).rejects.toThrow();
 });
});
