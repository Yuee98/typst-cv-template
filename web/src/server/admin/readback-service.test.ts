import { describe, expect, it, vi } from "vitest";
import { produceAdminRuntimeReadback, RuntimeReadbackProducerError } from "./readback-service";
import { candidate as config, environment } from "./config-validation-fixtures";
const input={policyVersionId:"33333333-3333-4333-8333-333333333333",validationReportIds:["44444444-4444-4444-8444-444444444444"]};
const route = Object.fromEntries(Object.entries(config.runtimeTarget).filter(([key])=>!["runtimeContractId","recipientKey","legalBundleVersion"].includes(key)));
function candidate(){return {
 schemaVersion:"admin_runtime_readback_candidate_v3",environment:"local",projectRef:"local",
 closingCycleId:"66666666-6666-4666-8666-666666666666",controlRevision:"7",configGeneration:"8",policyVersionId:input.policyVersionId,
 legalBundleVersion:config.runtimeTarget.legalBundleVersion,validationReportIds:input.validationReportIds,effectiveRoutes:[route],candidates:[config],
};}
function report(){
 const base=Object.fromEntries(Object.entries(candidate()).filter(([key])=>key!=="candidates"));
 const checkedAt=new Date(Date.now()-1_000);
 return {...base,schemaVersion:"admin_runtime_readback_v3",reportId:"55555555-5555-4555-8555-555555555555",checkedAt:checkedAt.toISOString(),expiresAt:new Date(checkedAt.getTime()+9*60_000).toISOString(),reportSha256:"a".repeat(64)};
}
function setup(observed:unknown=candidate(),saved:unknown=report()){
 const rpc=vi.fn().mockResolvedValueOnce({data:observed,error:null}).mockResolvedValueOnce({data:saved,error:null});
 return {rpc,client:{rpc}};
}
describe("current-runtime configuration readback",()=>{
 it("observes code and credentials before recording the exact closing cycle",async()=>{
  const {rpc,client}=setup();
  const result=await produceAdminRuntimeReadback(input,{environment,client});
  expect(result.reportId).toBe(report().reportId);
  expect(rpc.mock.calls[1]).toEqual(["record_admin_runtime_readback_v3",{
   p_environment:"local",p_project_ref:"local",p_policy_version_id:input.policyVersionId,p_validation_report_ids:input.validationReportIds,
   p_expected_closing_cycle_id:candidate().closingCycleId,p_expected_control_revision:"7",p_expected_config_generation:"8",
  }]);
  expect(JSON.stringify(rpc.mock.calls)).not.toContain("secret-value");
 });
 it.each([
  {environment:"preview"}, {projectRef:"other"}, {policyVersionId:"77777777-7777-4777-8777-777777777777"},
  {validationReportIds:["77777777-7777-4777-8777-777777777777"]},
  {candidates:[]}, {candidates:[config,config]},
  {effectiveRoutes:[{...route,priceVersionId:"77777777-7777-4777-8777-777777777777"}]},
  {candidates:[{...config,runtimeTarget:{...config.runtimeTarget,recipientKey:"xiaomi-mimo"}}]},
  {candidates:[{...config,runtimeTarget:{...config.runtimeTarget,codeCapabilitySha256:"f".repeat(64)}}]},
 ])("rejects crossed candidates before recording",async(patch)=>{
  const {rpc,client}=setup({...candidate(),...patch});
  await expect(produceAdminRuntimeReadback(input,{environment,client})).rejects.toBeInstanceOf(RuntimeReadbackProducerError);
  expect(rpc).toHaveBeenCalledTimes(1);
 });
 it("does not produce readiness when current runtime secret is missing",async()=>{
  const {rpc,client}=setup();
  await expect(produceAdminRuntimeReadback(input,{environment:{...environment,AI_PROVIDER_KEY_DEEPSEEK_PRIMARY:undefined},client})).rejects.toThrow();
  expect(rpc).toHaveBeenCalledTimes(1);
 });
 it.each([
  {closingCycleId:"77777777-7777-4777-8777-777777777777"},{controlRevision:"9"},{configGeneration:"10"},
  {environment:"preview"},{effectiveRoutes:[{...route,codeCapabilitySha256:"e".repeat(64)}]},
  {credential:"hidden-value"},{expiresAt:new Date(Date.now()-1_000).toISOString()},
 ])("rejects crossed or stale recorded results",async(patch)=>{
  const {client}=setup(candidate(),{...report(),...patch});
  await expect(produceAdminRuntimeReadback(input,{environment,client})).rejects.toBeInstanceOf(RuntimeReadbackProducerError);
 });
 it("does not call service RPCs for invalid input or environment",async()=>{
  const {rpc,client}=setup();
  await expect(produceAdminRuntimeReadback({...input,validationReportIds:[]},{environment,client})).rejects.toThrow();
  await expect(produceAdminRuntimeReadback(input,{environment:{},client})).rejects.toThrow();
  expect(rpc).not.toHaveBeenCalled();
 });
});
