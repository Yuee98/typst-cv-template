"use client";

import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { adminCommittedOperationSchema, adminErrorSchema, adminMutationRequestSchema, type AdminContext, type AdminRecord, type AdminSection } from "@/lib/admin/contract";
type Field = {
  name: string;
  kind?: "json" | "number" | "boolean" | "datetime";
  value?: unknown;
};
type Action = {
  operation: string;
  label: string;
  zh: string;
  fields: Field[];
};
const identity: Field[] = [{
  name: "code"
}, {
  name: "name"
}, {
  name: "description",
  value: ""
}];
const lifecycle: Field[] = [{
  name: "external_id"
}, {
  name: "expected_revision",
  value: "1"
}, {
  name: "expected_status",
  value: "DRAFT"
}, {
  name: "config_digest"
}];
export const adminActions: Record<string, Action[]> = {
  providers: [{
    operation: "admin_provider_update",
    label: "Update provider defaults",
    zh: "修改提供方默认值",
    fields: [{
      name: "external_id"
    }, {
      name: "expected_revision",
      value: "1"
    }, {
      name: "name"
    }, {
      name: "description",
      value: ""
    }, {
      name: "defaults",
      kind: "json",
      value: {
        capability_code: null,
        endpoint_url: null,
        credential_ref: null,
        model_id: null
      }
    }]
  }],
  profiles: [{
    operation: "admin_profile_create",
    label: "Create profile",
    zh: "新建执行配置",
    fields: [{
      name: "provider_id"
    }, ...identity]
  }, {
    operation: "admin_profile_version_create",
    label: "Create profile version",
    zh: "新建配置版本",
    fields: [{
      name: "profile_id"
    }, {
      name: "expected_revision",
      value: "1"
    }, {
      name: "capability_code"
    }, {
      name: "endpoint_url"
    }, {
      name: "credential_ref"
    }, {
      name: "model_id"
    }, {
      name: "disclosure_id"
    }, {
      name: "adapter_config",
      kind: "json",
      value: {}
    }]
  }, ...(["publish", "retire"] as const).map(action => ({
    operation: `admin_profile_version_${action}`,
    label: `${action} profile version`,
    zh: action === "publish" ? "发布配置版本" : "退役配置版本",
    fields: [...lifecycle, ...(action === "publish" ? [{
      name: "validation_id"
    }] : [])]
  })), {
    operation: "admin_profile_retire",
    label: "Retire profile",
    zh: "退役执行配置",
    fields: [{
      name: "external_id"
    }, {
      name: "expected_revision",
      value: "1"
    }]
  }],
  prices: [{
    operation: "admin_price_version_create",
    label: "Create price",
    zh: "新建价格版本",
    fields: [{
      name: "profile_version_id"
    }, {
      name: "expected_revision",
      value: "1"
    }, {
      name: "lane_code",
      value: "STANDARD"
    }, {
      name: "currency",
      value: "CNY"
    }, {
      name: "calculator_kind",
      value: "linear_token_v1"
    }, {
      name: "valid_from",
      kind: "datetime"
    }, {
      name: "valid_until",
      kind: "datetime",
      value: null
    }, {
      name: "parameters",
      kind: "json",
      value: {}
    }, {
      name: "components",
      kind: "json",
      value: {
        INPUT_STANDARD: "0",
        INPUT_CACHE_READ: "0",
        INPUT_CACHE_WRITE: "0",
        OUTPUT: "0"
      }
    }]
  }, ...(["publish", "retire", "close", "replace"] as const).map(action => ({
    operation: `admin_price_version_${action}`,
    label: `${action} price`,
    zh: {
      publish: "发布价格",
      retire: "退役价格",
      close: "关闭价格",
      replace: "原子接续价格"
    }[action],
    fields: [...lifecycle, ...(["publish", "replace"].includes(action) ? [{
      name: "validation_id"
    }] : []), ...(action === "replace" ? [{
      name: "currency",
      value: "CNY"
    }, {
      name: "lane_code",
      value: "STANDARD"
    }, {
      name: "calculator_kind",
      value: "linear_token_v1"
    }, {
      name: "parameters",
      kind: "json" as const,
      value: {}
    }, {
      name: "components",
      kind: "json" as const,
      value: {
        INPUT_STANDARD: "0",
        INPUT_CACHE_READ: "0",
        INPUT_CACHE_WRITE: "0",
        OUTPUT: "0"
      }
    }] : [])]
  }))],
  policies: [{
    operation: "admin_policy_create",
    label: "Create policy",
    zh: "新建路由策略",
    fields: identity
  }, {
    operation: "admin_policy_version_create",
    label: "Create policy version",
    zh: "新建策略版本",
    fields: [{
      name: "policy_id"
    }, {
      name: "expected_revision",
      value: "1"
    }, {
      name: "bundle_id"
    }, {
      name: "options",
      kind: "json",
      value: [{
        key: "A",
        profile_version_id: "",
        price_lane_code: "STANDARD",
        display_order: 0
      }]
    }, {
      name: "rules",
      kind: "json",
      value: [{
        ordinal: 0,
        is_fallback: true,
        weekday: null,
        start_minute: null,
        end_minute: null,
        option_keys: ["A"],
        default_option_key: "A"
      }]
    }]
  }, ...(["publish", "retire"] as const).map(action => ({
    operation: `admin_policy_version_${action}`,
    label: `${action} policy version`,
    zh: action === "publish" ? "发布策略版本" : "退役策略版本",
    fields: [...lifecycle, ...(action === "publish" ? [{
      name: "validation_id"
    }] : [])]
  })), {
    operation: "admin_policy_retire",
    label: "Retire policy",
    zh: "退役路由策略",
    fields: [{
      name: "external_id"
    }, {
      name: "expected_revision",
      value: "1"
    }]
  }],
  users: [...(["grant", "revoke"] as const).map(action => ({
    operation: `admin_member_${action}`,
    label: `${action} administrator`,
    zh: action === "grant" ? "授予管理员" : "撤销管理员",
    fields: [{
      name: "auth_user_id"
    }, {
      name: "expected_revision",
      value: "1"
    }]
  }))],
  controls: [{
    operation: "admin_ai_disable",
    label: "Disable AI",
    zh: "紧急关闭 AI",
    fields: [{
      name: "expected_revision"
    }]
  }, {
    operation: "admin_ai_set_policy",
    label: "Set policy",
    zh: "设置策略指针",
    fields: [{
      name: "expected_revision"
    }, {
      name: "policy_version_id"
    }, {
      name: "validation_id"
    }]
  }, {
    operation: "admin_ai_reopen",
    label: "Enable AI",
    zh: "开启 AI",
    fields: [{
      name: "expected_revision"
    }, {
      name: "readback_id"
    }]
  }, {
    operation: "admin_ai_update_limits",
    label: "Update limits",
    zh: "修改额度",
    fields: [{
      name: "expected_revision"
    }, {
      name: "user_daily_limit",
      kind: "number",
      value: "20"
    }, {
      name: "global_daily_limit",
      kind: "number",
      value: "2000"
    }, {
      name: "user_minute_limit",
      kind: "number",
      value: "3"
    }]
  }, {
    operation: "admin_ai_set_audience",
    label: "Set audience",
    zh: "设置开放范围",
    fields: [{
      name: "expected_revision"
    }, {
      name: "audience",
      value: "ALLOWLIST"
    }]
  }, {
    operation: "admin_ai_set_allowed_user",
    label: "Set allowed user",
    zh: "修改允许用户",
    fields: [{
      name: "expected_revision"
    }, {
      name: "auth_user_id"
    }, {
      name: "allowed",
      kind: "boolean",
      value: true
    }]
  }]
};
function fieldTitle(name: string) {
  return name.replaceAll("_", " ");
}
export function AdminRecordActions({
  section,
  record,
  context,
  accessToken,
  locale,
  onCommitted
}: {
  section: AdminSection;
  record?: AdminRecord | null;
  context: AdminContext;
  accessToken: string;
  locale: "zh" | "en";
  onCommitted: () => void;
}) {
  const actions = adminActions[section] ?? [];
  const [selected, setSelected] = useState(actions[0]?.operation ?? "");
  const action = actions.find(a => a.operation === selected) ?? actions[0];
  const [values, setValues] = useState<Record<string, string>>({});
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [committedResult, setCommittedResult] = useState<AdminRecord | null>(null);
  const pending = useRef<Record<string, unknown> | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const initial = (() => {
    const result: Record<string, string> = {};
    for (const field of action?.fields ?? []) {
      const value = field.name === "expected_revision" ? record?.revision ?? record?.parent_revision ?? (section === "controls" ? context.control.revision : field.value) : (field.name === "expected_status" ? record?.status : record?.[field.name]) ?? (field.name === "profile_id" && String(record?.external_id).startsWith("prf_") || field.name === "policy_id" && String(record?.external_id).startsWith("pol_") ? record?.external_id : field.value);
      result[field.name] = field.kind === "json" ? JSON.stringify(value ?? {}, null, 2) : value == null ? "" : String(value);
    }
    return result;
  })();
  if (!action) return null;
  async function submit() {
    setBusy(true);
    setMessage("");
    try {
      if (!pending.current) {
        const body: Record<string, unknown> = {
          operation: action.operation,
          contract_code: context.contract_code,
          database_instance_id: context.database_instance_id,
          operation_key: crypto.randomUUID(),
          reason
        };
        for (const field of action.fields) {
          const raw = values[field.name] ?? initial[field.name] ?? "";
          body[field.name] = field.kind === "json" ? JSON.parse(raw) : field.kind === "number" ? raw : field.kind === "boolean" ? raw === "true" : field.kind === "datetime" ? raw ? new Date(raw).toISOString() : null : field.name === "policy_version_id" && !raw ? null : raw;
        }
        pending.current = adminMutationRequestSchema.parse(body);
      }
      const response = await fetch("/api/admin", {
        method: "POST",
        cache: "no-store",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(pending.current)
      });
      const raw: unknown = await response.json();
      if (!response.ok) {
        const error = adminErrorSchema.parse(raw);
        if (response.status < 500) {
          pending.current = null;
          setUncertain(false);
        } else setUncertain(true);
        setMessage(error.error.code);
        return;
      }
      const result = adminCommittedOperationSchema.parse(raw);
      pending.current = null;
      setUncertain(false);
      setCommittedResult(result.result);
      setMessage(`${locale === "zh" ? "已提交" : "Committed"}: ${result.operation_id}`);
      onCommitted();
    } catch (error) {
      if (pending.current) {
        setUncertain(true);
        setMessage(locale === "zh" ? "结果尚不确定，请保留当前表单并重试同一操作。" : "Result unknown. Keep this form and retry the same operation.");
      } else setMessage(error instanceof Error ? error.message : "INVALID_REQUEST");
    } finally {
      setBusy(false);
    }
  }
  return <section className="min-w-0 space-y-3 rounded border border-border p-4"><h2 className="font-semibold">{locale === "zh" ? "配置操作" : "Configuration actions"}</h2>
 <select aria-label={locale === "zh" ? "操作" : "Action"} className="w-full min-w-0 max-w-full rounded border border-border bg-bg p-2" disabled={busy || uncertain} value={selected} onChange={event => {
      setSelected(event.target.value);
      setValues({});
      setMessage("");
    }}>{actions.map(a => <option key={a.operation} value={a.operation}>{locale === "zh" ? a.zh : a.label}</option>)}</select>
 <fieldset disabled={busy || uncertain} className="grid min-w-0 gap-3 md:grid-cols-2">{action.fields.map(field => <label key={field.name} className={field.kind === "json" ? "min-w-0 md:col-span-2" : "min-w-0"}><span className="mb-1 block break-words text-sm capitalize">{fieldTitle(field.name)}</span>{field.kind === "json" ? <textarea className="w-full min-w-0 max-w-full resize-y overflow-auto whitespace-pre-wrap break-words rounded border border-border bg-bg p-2 font-mono text-xs" rows={6} value={values[field.name] ?? initial[field.name]} onChange={event => setValues({
          ...values,
          [field.name]: event.target.value
        })} /> : field.kind === "boolean" ? <select className="min-w-0 max-w-full rounded border border-border bg-bg p-2" value={values[field.name] ?? initial[field.name]} onChange={event => setValues({
          ...values,
          [field.name]: event.target.value
        })}><option value="true">{locale === "zh" ? "是" : "Yes"}</option><option value="false">{locale === "zh" ? "否" : "No"}</option></select> : <Input className="min-w-0 max-w-full" type={field.kind === "number" ? "number" : "text"} placeholder={field.kind === "datetime" ? "2026-11-07T00:00:00Z" : undefined} value={values[field.name] ?? initial[field.name]} onChange={event => setValues({
          ...values,
          [field.name]: event.target.value
        })} />}</label>)}<label className="min-w-0 md:col-span-2"><span className="block break-words text-sm">{locale === "zh" ? "操作原因" : "Reason"}</span><Input className="min-w-0 max-w-full" value={reason} maxLength={500} onChange={e => setReason(e.target.value)} /></label></fieldset>
 <Button className="h-auto min-h-9 max-w-full whitespace-normal py-2" disabled={busy || reason.trim().length < 3} onClick={() => void submit()}>{locale === "zh" ? uncertain ? "重试同一操作" : "提交操作" : uncertain ? "Retry same operation" : "Submit"}</Button>{message && <p role="status" className="min-w-0 break-all text-sm">{message}</p>}{committedResult && <dl className="min-w-0 space-y-1 rounded border border-border p-3 text-sm">{Object.entries(committedResult).map(([key, value]) => <div key={key} className="min-w-0"><dt className="break-words capitalize text-foreground-muted">{fieldTitle(key)}</dt><dd className="max-h-80 min-w-0 max-w-full overflow-auto whitespace-pre-wrap break-all">{typeof value === "object" ? JSON.stringify(value, null, 2) : String(value ?? "—")}</dd></div>)}</dl>}</section>;
}
