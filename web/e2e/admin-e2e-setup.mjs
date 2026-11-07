import { spawnSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
export const E2E_USERS={admin:{email:"admin-e2e-admin@example.test",password:"AdminE2E!local-2026"},ordinary:{email:"admin-e2e-ordinary@example.test",password:"OrdinaryE2E!local-2026"}};
const literal=value=>`'${String(value).replaceAll("'","''")}'`;
function requireLocal(url){if(url!=="http://127.0.0.1:54321")throw new Error("Admin E2E refuses non-local Supabase");}
function ownerSql(statement){const result=spawnSync("docker",["exec","-i","supabase_db_typst-cv-template","psql","-U","postgres","-d","postgres","--set","ON_ERROR_STOP=1","--no-psqlrc"],{input:statement,encoding:"utf8",timeout:60000});if(result.status!==0)throw new Error(result.stderr||"Local fixture SQL failed");}
function serviceClient(url,secretKey){requireLocal(url);if(!secretKey)throw new Error("Missing local service credential");return createClient(url,secretKey,{auth:{persistSession:false,autoRefreshToken:false}});}
async function removeFixtureUsers(service){const {data,error}=await service.auth.admin.listUsers({perPage:1000});if(error)throw error;const users=data.users.filter(user=>Object.values(E2E_USERS).some(spec=>spec.email===user.email));if(!users.length)return;const ids=`array[${users.map(user=>`${literal(user.id)}::uuid`).join(",")}]`;
 ownerSql(`begin;
 alter table audit.events disable trigger user;
 alter table admin.operations disable trigger user;
 delete from audit.events where actor_auth_user_id=any(${ids}) or operation_id in(select id from admin.operations where actor_auth_user_id=any(${ids}));
 delete from admin.operations where actor_auth_user_id=any(${ids});
 delete from admin.members where auth_user_id=any(${ids});
 delete from ai.profiles where user_created=any(${ids}) and code like 'ADMIN_E2E_%' and not exists(select 1 from ai.profile_versions v where v.profile_id=ai.profiles.id);
 alter table admin.operations enable trigger user;
 alter table audit.events enable trigger user;
 commit;`);
 for(const user of users){const {error}=await service.auth.admin.deleteUser(user.id);if(error)throw error;}
}
export async function setupAdminE2e({url,secretKey}){
 const service=serviceClient(url,secretKey);await removeFixtureUsers(service);const users={};
 for(const [name,spec] of Object.entries(E2E_USERS)){const {data,error}=await service.auth.admin.createUser({...spec,email_confirm:true});if(error||!data.user)throw error??new Error("Fixture account unavailable");users[name]=data.user;}
 ownerSql(`do $fixture$ begin
 if not exists(select 1 from admin.environment) then perform admin.initialize('LOCAL',${literal(users.admin.id)}::uuid);
 elsif exists(select 1 from admin.environment where name<>'LOCAL') then raise exception 'Local fixture environment mismatch';
 else insert into admin.members(auth_user_id,user_created,user_updated) values(${literal(users.admin.id)}::uuid,${literal(users.admin.id)}::uuid,${literal(users.admin.id)}::uuid);end if;
 if (select enabled from ai.runtime_control where id=1) then raise exception 'Admin E2E requires AI disabled';end if;
 end $fixture$;`);
}
export async function cleanupAdminE2e({url,secretKey}){await removeFixtureUsers(serviceClient(url,secretKey));}
