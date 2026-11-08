// Local/CI fake smoke. Never runs against a hosted deployment or provider.
import assert from "node:assert/strict";
const base=new URL(process.argv[2]??"http://127.0.0.1:3000");
if(!["127.0.0.1","localhost","[::1]"].includes(base.hostname))throw new Error("Smoke requires a loopback server");
const headers={authorization:"Bearer ci-smoke-token","content-type":"application/json"};
async function read(path,init){const response=await fetch(new URL(path,base),{...init,signal:AbortSignal.timeout(10000)});const body=await response.json();assert.match(response.headers.get("cache-control")??"",/no-store/);assert.equal(response.headers.get("x-request-id"),body.requestId);return {response,body};}
for(const path of ["/api/polish/quota","/api/polish/availability"]){const {response,body}=await read(path);assert.equal(response.status,401);assert.equal(body.error.code,"UNAUTHORIZED");}
const {response:availabilityResponse,body:{availability}}=await read("/api/polish/availability",{headers});
assert.equal(availabilityResponse.status,200);assert.equal(availability.contract,"cv_app_db_2");assert.equal(availability.configurations.length,2);assert.equal(availability.enabled,true);
assert(!JSON.stringify(availability).includes("credential_ref"));assert(availability.configurations.every(configuration => !("endpoint_url" in configuration)));
const option=availability.configurations[1];
const expectedRoute={contract:availability.contract,databaseInstanceId:availability.databaseInstanceId,controlRevision:availability.controlRevision,configId:option.configId,configRevision:option.configRevision,commonDocumentAuditId:option.legalDisplay.common.document_audit_id,providerDocumentAuditId:option.legalDisplay.provider.document_audit_id};
const request={clientRequestId:crypto.randomUUID(),granularity:"item",sectionId:"experience",language:"zh",items:[{id:"i0",kind:"experience_bullet",text:"负责后端核心服务的开发与优化，将 P99 延迟降低 40%。"}],context:{level:0,references:[]},expectedRoute};
const success=await read("/api/polish",{method:"POST",headers,body:JSON.stringify(request)});assert.equal(success.response.status,200,JSON.stringify(success.body));assert.equal(success.body.items[0].id,"i0");assert.equal(success.body.quota.remaining,19);
const replay=await read("/api/polish",{method:"POST",headers,body:JSON.stringify(request)});assert.equal(replay.response.status,409);assert.equal(replay.body.error.code,"CONFLICT");assert.equal(replay.body.error.reason,"ALREADY_FINALIZED");
const stale=await read("/api/polish",{method:"POST",headers,body:JSON.stringify({...request,clientRequestId:crypto.randomUUID(),expectedRoute:{...expectedRoute,controlRevision:"999"}})});assert.equal(stale.response.status,409);assert.equal(stale.body.error.reason,"CONFIG_CHANGED");
const quota=await read("/api/polish/quota",{headers});assert.equal(quota.response.status,200);assert.equal(quota.body.quota.remaining,19);
console.log("AI current-contract local smoke passed: selection, safe projection, execution, replay and stale revision.");
