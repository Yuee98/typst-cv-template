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
pnpm --filter web dev
```

### 构建与检查

```powershell
pnpm --filter web build
pnpm --filter web lint
pnpm --filter web typecheck
```

在 dev 和 build 之前，Web 应用会先将根目录的 `style.typ` 同步到 `web/public/typst/style.typ`，因此根目录的 Typst 样式始终保持唯一数据源。

### 部署到 Vercel

部署时保持项目根目录为仓库根目录：

- Build command: `pnpm --filter web build`
- Output directory: `web/out`
