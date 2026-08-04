# Typst CV Template

[English](README.md) | [中文](README_CN.md)

一个简洁的双语简历模板，基于 Typst 构建；同时附带一个 Web 端简历编辑器，可在浏览器中渲染同一套模板。

本项目包含两个主要部分：

1. **[Typst 模板](#typst-模板)** —— 可独立 `#import` 的模板，可用于你自己的 Typst 项目。
2. **[Web 简历编辑器](#web-简历编辑器)** —— 基于 Next.js 的在线简历编辑、预览与导出工具。

---

## Typst 模板

模板入口为 `style.typ`，可直接导入到任意 Typst 文档中使用。

### 环境要求

- [Typst](https://typst.app/)
- 支持目标语言的字体。默认字体栈为 `Times New Roman`、`Noto Serif SC` 和 `SimSun`。

### 编译

```powershell
# 如输出目录不存在则先创建
mkdir -p output/pdf

# 编译示例简历
typst compile .\resume_cn.typ .\output\pdf\cv_cn_typst.pdf
typst compile .\resume_en.typ .\output\pdf\cv_en_typst.pdf
typst compile .\resume_mixed.typ .\output\pdf\cv_mixed_typst.pdf

# 本地编辑时使用 watch 模式
typst watch .\resume_cn.typ .\output\pdf\cv_cn_typst.pdf
```

### 文件说明

- `style.typ`：共享的排版与布局辅助函数，也是可复用的模板入口。
- `resume_cn.typ`：中文简历入口。
- `resume_en.typ`：英文简历入口。
- `resume_mixed.typ`：中英混合简历入口。
- `content/cn.typ`：中文简历示例内容。
- `content/en.typ`：英文简历示例内容。

### 内容辅助函数

- `resume-entry(...)`：单家公司或单个职位条目，适用于一个项目或职责范围。对于教育经历等应保持在同一页的短条目，可传入 `keep: true`。
- `company-entry(org, date)[...]`：一家公司或一个职位块。
- `project-entry(title, detail, bullets, date: none)`：公司块内部的项目或职责范围。`title` 用于职位或角色，`detail` 用于项目、团队或产品线。

`project-entry` 会将职位标题放在左侧，项目元数据放在右侧。如果提供了 `date`，会以内联形式渲染为 `date · detail`：日期保持正体，`detail` 为斜体。

章节标题会与后续内容保持在一起，bullet 项和论文列表也会尽量保持连续；较长的章节仍可在条目或 bullet 之间分页。

### 在自己的项目中使用本模板

你可以将真实简历内容放在私有仓库中，并通过 subtree 引入本模板：

```powershell
git remote add cv-template https://github.com/YOUR_NAME/typst-cv-template.git
git subtree add --prefix=template cv-template main --squash
```

然后在你私有的入口文件中 `import template/style.typ`，并引入你自己的内容文件。

---

## Web 简历编辑器

Web 应用位于 `web/` 目录下，是一个 Next.js 项目。它通过 [typst.ts](https://github.com/Myriad-Dreamin/typst.ts) 在浏览器中编译简历，并与独立 Typst 模板共用同一份 `style.typ`。

### 功能特性

- **Live Typst preview** —— 编辑时即可看到按可打印 A4 页面渲染的简历，与独立 Typst 项目使用同一套模板。
- **表单化编辑器** —— 通过结构化表单编辑 header、profile、skills、experience、education、research、publications 和 additional 等模块，无需手写 Typst 标记。
- **Drag-and-drop 排版** —— 使用 `@dnd-kit` 拖拽排序章节、公司、项目和条目。
- **灵活的存储方式** —— 可将简历存于浏览器本地、同步到云端，或使用客户端加密保护。
- **Authentication** —— 通过 Supabase 支持邮箱/密码或 GitHub OAuth 登录。
- **双语 UI** —— 编辑器界面支持英文和中文（基于 `next-intl`）。简历内容语言可独立设置（`zh` 或 `en`）。
- **自定义字体** —— 可选通过 Font Access API 选择本地字体，用于预览和 PDF 导出。
- **文档库管理** —— 在侧边栏管理多份简历，支持复制、重命名、删除、切换存储模式和拖拽排序。
- **Dark / light / system 主题** —— 通过 `next-themes` 切换外观。

### 隐私优先的加密存储

加密简历采用 **客户端 AES-GCM-256** 保护。加密密码通过 PBKDF2-SHA-256 派生密钥，且永远不会离开浏览器。服务器只存储加密后的数据，因此即使数据库管理员也无法读取你的简历内容。

- 每个 session 解锁一次加密简历后即可编辑。
- 可在受信任的设备上选择记住密码。
- 加密简历的修改不会自动保存，只有在你明确点击保存时才会同步。

因此，加密模式特别适合包含敏感个人信息或工作经历的简历。

### 导出格式

编辑器支持以下几种导出格式：

- **PDF** —— 由 Typst 渲染，可直接发送或打印。
- **`.typ` source** —— 独立的 Typst 源文件，会 `import style.typ`，方便你离线继续编辑。
- **`.zip` package** —— 包含源文件、`style.typ`、`data.json` 和一份简短 README。
- **JSON** —— 结构化的简历数据，可用于备份或重新导入编辑器。

### 开发

```powershell
pnpm install
pnpm dev   # 以 server 模式启动开发服务器（包含 API 路由）
```

### 构建与检查

Web 应用支持两种构建模式（见 `web/scripts/run-next-mode.mjs`）：

```powershell
pnpm build          # 默认 = server 构建
pnpm build:server   # 面向 Vercel 的 Node server 构建——包含生成的 /api/polish 路由
pnpm build:static   # 面向 GitHub Pages 的静态导出——无 API 路由、无 AI 入口
pnpm test           # vitest 单元测试
pnpm lint
pnpm typecheck
```

（以上均为根目录对 `web/` 包脚本的透传。）

`.github/workflows/ci.yml` 的 server-build job 会用仅限 CI 的 fake 鉴权/配额/provider 依赖启动构建产物，在不访问托管服务的情况下验证完整 API envelope。真实 DeepSeek + 本地 Supabase 的 release smoke 与 metrics 命令见 `web/README.md`；该 smoke 会产生费用并修改隔离的本地数据库，因此不会进入 CI。

在 dev 和 build 之前，Web 应用会先将根目录的 `style.typ` 同步到 `web/public/typst/style.typ`，因此根目录的 Typst 样式始终保持唯一数据源。

### AI 润色（仅 server 部署）

AI 润色已经覆盖受支持的自由文本字段，并通过三层相互独立的开关逐步开放：

| 开关 | 生效范围 | 用途 |
|---|---|---|
| `NEXT_PUBLIC_AI_POLISH_ENABLED` | 浏览器构建期 | 显示或移除 AI 入口，不是安全开关。`build:static` 会拒绝值为 `true` 的构建，因此 Pages 产物不可能包含 AI 入口。 |
| `AI_POLISH_ENABLED` | Vercel deployment | 在鉴权、数据库访问和 provider 调用之前禁用两个 AI API 路由。值不是精确的 `true` 时返回 `503 AI_DISABLED`；修改 Vercel env 后需要重新部署。 |
| `public.ai_feature_config.ai_polish_enabled` | Supabase 运行时 | 即时生效的运维 kill switch。reserve 和 provider-start RPC 还会在无需重新部署的情况下执行非空 canary allowlist 与全局日限。 |

API 路由（`/api/polish`、`/api/polish/quota`）只存在于 **server 构建**；静态 Pages 导出既不含路由，也不会获得任何 server-only secret。完整环境变量契约见 `web/.env.example`。

### 部署拓扑

`main` 是 staging 线，`release` 是 production 线；生产 promotion 始终由人手动发起：

| 交付面 | Git 来源 | 构建 | 数据库配置 | 触发方式 |
|---|---|---|---|---|
| Vercel Preview | `main` | Server | 独立测试 Supabase 项目 | push 或 merge 到 `main` |
| Test Supabase | `main` | `supabase/` migrations | 独立项目；GitHub Integration working directory 为 `.` | push 或 merge 到 `main` |
| Vercel Production | `release` | Server | 独立生产 Supabase 项目 | promotion 更新 `release` |
| Production Supabase | `release` | `supabase/` migrations | 独立项目；GitHub Integration working directory 为 `.` | promotion 更新 `release` |
| GitHub Pages | `Promote Release` 选定的 commit | 静态导出 | 仅使用公开 Supabase 变量；无 AI API 或 service-role key | 手动 promotion workflow |

`Promote Release` workflow 会验证来自 `main` 的选定 commit、构建静态产物、以可选生产 tag 原子前移 `release`，并部署 Pages。随后 `release` push 会分别触发 Vercel Production 与 Production Supabase；这些下游部署互不等待，也不会等待 Pages。

#### 一次性环境配置

Vercel 项目设置为 **Root Directory** `web`、**Framework Preset** `Next.js`、**Build Command** `pnpm build:server`、不设置 **Output Directory** override，并将 **Production Branch** 设为 `release`。

各环境使用独立配置，不要让 Preview 与 Production 共用生产数据库或 HMAC secret：

| 变量 | Preview | Production | 说明 |
|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | 测试项目 | 生产项目 | 可公开的项目连接信息 |
| `SUPABASE_SERVICE_ROLE_KEY` | 测试项目 | 生产项目 | Sensitive；仅服务端 |
| `DEEPSEEK_API_KEY` | 非生产 key，可与本地共用 | 最好使用独立生产 key | Sensitive；仅服务端 |
| `AI_USER_ID_HMAC_SECRET` | 独立随机 secret | 独立随机 secret | Sensitive；绝不使用 `NEXT_PUBLIC_` 前缀 |
| `AI_POLISH_ENABLED` | 首次关闭态部署为 `false` | 第一次生产 promotion 前为 `false` | 部署级 API 总闸 |
| `NEXT_PUBLIC_AI_POLISH_ENABLED` | 首次关闭态部署为 `false` | 第一次生产 promotion 前为 `false` | 构建期 UI 开关 |

托管环境不要设置 `POLISH_FAKE_LLM`、`POLISH_FAKE_BACKEND` 或 `NEXT_PUBLIC_AI_POLISH_MOCK`。`AI_POLISH_MODEL` 与 `AI_POLISH_GLOBAL_DAILY_LIMIT` 不是应用环境变量：模型固定在代码中，全局日限位于 `public.ai_feature_config`。

无法使用数据库 branching 时采用两个独立 Supabase 项目：测试项目 watch `main`，生产项目 watch `release`。应用 migrations 前，先在 `pg_catalog` schema 启用 `pg_cron`；migration 会创建 `ai-polish-retention-cleanup` 和 `ai-polish-stale-reconciliation`。每个项目的 GitHub Integration 中，“production branch”只表示部署到该项目的 Git 分支，并不意味着测试项目是面向用户的生产数据库。

#### 首次上线与后续发布

1. 保持两个 Vercel 开关为 `false`，合并一个 commit 到 `main`。要求 GitHub CI、Test Supabase deployment 和 Vercel Preview deployment 全部成功；确认 Preview 首页为 `200`、AI UI 不存在、已登录与未登录的 AI API 请求均被部署级开关阻止、两个 cron job active，且没有 provider 请求。
2. 配置非空测试账号 allowlist，开启测试数据库 runtime switch，将两个 **Preview** Vercel 开关改为 `true` 并重新部署。针对测试项目完成中英文浏览器、terms、E2EE 提醒、配额、取消、stale-write、删除、metrics 和真实 provider 验收。
3. 仅在 Preview 验收通过后运行 `Promote Release`。生产 migrations 和首次 server deployment 完成期间，两个 **Production** Vercel 开关继续保持 `false`；先验证关闭状态，再设置非空生产 canary allowlist。
4. 开启两个 Production Vercel 开关并重新部署，同时保持数据库 runtime switch 关闭。精确 deployment 验证通过后，仅为 allowlist canary 账号开启数据库开关；清空 allowlist、全局开放仍是独立人工决策。

首次上线完成后，Vercel 开关可以持续保持 `true`。如果 migration 不向后兼容，应在 promotion 前关闭数据库 runtime switch，精确生产 deployment 验证后再开启；普通发布无需反复修改 Vercel env。
