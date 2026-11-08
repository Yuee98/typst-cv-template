# 数据库重建与发布手册

状态：第二轮实现与本地验收完成，结果见 [验证记录](database-rebuild-verification.md)。尚未执行 test/prod SQL、重置、配置变更、promotion 或发布。本文件只描述未来受控切换流程。

## 目标与保留项

继续使用已有 Supabase 项目。test 监听 main，prod 监听 release；两者应用同一份提交及新迁移清单。保留 GitHub 定时 keepalive Action 和 public.keep_project_active()、GitHub SSO/OAuth/回调/重定向、API 与 Git 集成配置。

用户已允许丢弃业务数据及 Auth 用户数据。现有重建工具仍采用经过演练的应用对象白名单清理，不直接 DROP 平台 schema；允许删用户不等于允许删除 OAuth/SSO 配置。若实际选择清理 Auth 用户，必须单独核对用户数据与配置表边界，不把原生 hosted db reset 当作保留 SSO 的保证。

## 本地开发和验证

使用仓库固定 Supabase CLI 2.109.0。每次执行前使用 --help 核对选项；不使用本机保存的 hosted link 作为操作目标。普通开发仅使用显式 --local 与本机 Docker。

新基线文件由 CLI migration new 创建，按 schema/stage 顺序存放 migrations。supabase/baseline.json 明确冻结基线列表，全部文件 hash 组成 baseline_digest；完整当前迁移链形成 migration_manifest_digest。本轮移除 TOTP 按用户授权直接重写原 15 条迁移并重建本地测试库；正式发布后基线不再改写，修复以追加文件演进。

本地空库重建后运行 SQL 角色/约束测试、真实 Auth/Data API 集成、隔离库两连接竞态和 Admin 浏览器测试，再做 typecheck/lint/服务端与静态构建。合成 Auth/session 数据只能出现在明确 disposable fixture；浏览器验证真实普通登录即可执行管理员读写，并验证无权限或失效会话仍被拒绝。应用不设计 TOTP 绑定或 AAL2 门槛。

普通本地 seed 不含生产密钥、生产用户或预置同意。adapters、审核后的条款与 AI 默认关闭状态随 migration；真实服务配置通过 Admin 的普通保存建立。

## 受控工具

scripts/db-rebuild.ts 提供 plan、rebuild、resume、verify。plan 默认只读。hosted 模式必须显式绑定 target、project ref、完整 source SHA、目标连接与 CA；连接使用完整 TLS 验证，不从开发 .env 推断目标。

必须在 GitHub 环境互斥锁内执行，持久 Actions-variable state 记录 operation、phase、项目、SHA、基线/完整清单摘要、清理方法与清理 SQL/inventory 摘要。网络断开后先检查实际 catalog/history 和既有 state，不能因结果不确定重复清空。

hosted 初始化仅由重建工具的受控阶段完成。独立 db-initialize.ts 仅允许 --local，输入已有且有效的 Auth 管理员 UUID。初始化同时建立环境实例和首管理员；不猜用户、不自动接受条款、不自动启用 AI。jobs 注册后保持 inactive，待验收完成才启用。

## 发布前材料

- 本次完整提交 SHA；baseline.json 对应文件及全链 hash，当前迁移历史。
- 本地测试与两种构建通过记录；当前实现的角色允许/拒绝结果。
- 独立 disposable remote-mode 演练证明：旧应用对象清理、平台指纹、迁移后中断、重复 resume、检查点丢失拒绝/检查后恢复。
- test/prod 项目映射和连接身份、CLI/Postgres 版本、Data API exposed schemas、RLS/GRANT、Auth/OAuth/SSO、cron 及 Git watch 配置盘点。
- 维护暂停、发布和失败恢复的执行人及窗口；真实 AI key 仅记录引用名和存在状态。

演练证明绑定实际候选 SHA 和两类清单摘要。工作树旧证据、上一轮十条链、仅 native local reset 或手工构造窗口不能冒充新基线的完整 hosted 模式证明。证明不得包含 key、访问令牌、用户正文或连接密码。

## Test 切换

1. 固定候选 SHA，先只读 plan。暂停该环境自动数据库同步、应用发布及可能写入的任务，确认没有旧队列。
2. 验证维护状态和平台保留项；记录清理授权、项目和清单摘要后执行 application_allowlist 清理。
3. 按顺序应用新基线并核对迁移历史、角色边界和 current contract。不得将未执行文件通过 migration repair 标为已应用。
4. 用现有有效 Auth 用户初始化 PREVIEW 和首管理员，生成新的 database_instance_id。若用户已清理，先通过真实 Auth 建立管理员。
5. 部署与同 SHA 配套的应用，核验客户端发现实例改变后拒绝旧 ID/缓存，不自动重传旧云端草稿或同意记录。
6. 在 Admin 保存真实接入配置及价格、候选时间规则、开放范围/额度；检查 endpoint 与披露 scope、密钥引用、有效会话和管理员资格。
7. 验收当前条款/准确阅读链接、显式选项与同意、CV v7、取消/额度/费用、多币种和手机/宽屏 Admin。任何付费 Provider smoke 必须属于已授权范围。
8. 必要时启用 AI 与任务，记录验收证据。只有在历史和 main 的文件完全一致后，才恢复既有 Git watch、应用自动部署与 keepalive。

## Prod 切换

prod 只接受同 SHA、同基线/完整清单且已通过 test 的材料。重复上述维护、清理、初始化 PRODUCTION、应用部署与验收流程。prod 独立生成实例、用户授权和服务配置，不复制 test 的用户/接受/请求/管理员数据。

不删除 release 分支、不强推 main，也不把清库塞进日常 Promote Release。prod 正常发布仍为 main/test 验收后 promotion 到 release；历史与监听分支同步后才恢复集成。

## 失败与恢复

| 状态 | 处理 |
| --- | --- |
| 未开始清理 | 保持维护，修正候选代码/材料并重新验收 |
| reset_started 结果不明 | 先 plan 和 catalog/history 检查，用绑定实时清单的恢复证明推进；禁止盲目重清 |
| 基线部分应用 | 只补缺失文件，保留同一实例与 durable state |
| DB ready、应用发布失败 | 重试同 SHA 应用发布；如需代码/DDL修复，先在 test 验收并追加迁移 |
| 配置/价格/条款不匹配 | AI 保持关闭，在单个业务保存事务修正，不恢复旧版本或默认 fallback |
| 已发送但结果未知 | 保留 HELD 与额度，不猜测免费；迟到事实仍可结算 |

已进入 DB-ready 后，不能因为 SHA 或应用构建失败再次清库。后续追加迁移不得改写已应用历史。验证结束后的本地证明与线上执行记录分开，未实际执行的步骤不标记为完成。
