import type { CvData } from "./schema";

export const sampleCvData: CvData = {
  schemaVersion: 5,
  typstLang: "zh",
  header: {
    name: "周林",
    subtitle: "Senior Full-Stack Engineer | Platform Engineering | AI Products",
    email: "lin.zhou@example.com",
    phone: "+1 415-555-0128",
    selfName: "Lin Zhou",
  },
  sectionTitles: {
    profile: { title: "个人简介", isDisplay: true },
    skills: { title: "技术能力", isDisplay: true },
    experience: { title: "工作经历", isDisplay: true },
    education: { title: "教育背景", isDisplay: true },
    research: { title: "研究经历", isDisplay: true },
    publications: { title: "发表成果", isDisplay: true },
    additional: { title: "其他", isDisplay: true },
  },
  profile: [
    {
      body: "全栈工程师，长期参与 B2B SaaS、AI workflow 和内部平台建设，能够从产品需求、系统设计一路推进到上线交付。",
    },
    {
      body: "关注 developer experience、type-safe API、可观测性和性能优化，习惯在中英文团队环境中推动工程规范落地。",
    },
  ],
  skills: [
    {
      label: "前端开发",
      body: "TypeScript、React、Next.js、React Hook Form、Zod、Design System、复杂表单与可访问性",
    },
    {
      label: "后端开发",
      body: "Node.js、C#/.NET、REST API、PostgreSQL、SQL Server、权限模型、任务队列",
    },
    {
      label: "平台工程",
      body: "CI/CD、Docker、Vercel、Azure、OpenTelemetry、feature flags、发布与回滚流程",
    },
    {
      label: "AI 产品",
      body: "LLM workflow、prompt evaluation、human-in-the-loop review、RAG 原型和内部工具自动化",
    },
    {
      label: "协作能力",
      body: "技术方案写作、code review、跨时区沟通、mentoring、英文技术文档",
    },
  ],
  experience: [
    {
      org: "Northstar Labs 北辰实验室",
      date: "2023年 - 至今",
      projects: [
        {
          title: "Senior Software Engineer",
          detail: "AI Workflow Platform",
          date: "2024年 - 至今",
          bullets: [
            {
              body: "负责 LLM task orchestration、人工审批流和 audit log 的端到端实现，支持运营团队配置多步骤自动化流程。",
            },
            {
              body: "用 Zod schema 和 typed API contract 统一前后端数据边界，减少表单回归问题并提升 review 效率。",
            },
          ],
        },
        {
          title: "Full-Stack Engineer",
          detail: "Developer Portal / Design System",
          date: "2023年 - 2024年",
          bullets: [
            {
              body: "建设内部 developer portal，整合服务目录、runbook、on-call dashboard 和发布检查清单。",
            },
            {
              body: "抽象 React 组件和 shadcn/ui 封装层，统一表单、表格、空状态和错误反馈体验。",
            },
          ],
        },
      ],
    },
    {
      org: "HarborCloud 数据平台",
      date: "2020年 - 2023年",
      projects: [
        {
          title: "Software Engineer",
          detail: "Order & Fulfillment Platform",
          date: "",
          bullets: [
            {
              body: "维护订单履约、库存同步和客户通知模块，参与从 legacy service 到 event-driven API 的迁移。",
            },
            {
              body: "优化高频 SQL 查询和批量导入流程，将关键后台任务的平均处理时间降低 35%。",
            },
          ],
        },
      ],
    },
  ],
  education: [
    {
      org: "Riverstone University",
      title: "M.S. in Computer Science",
      detail: "Distributed Systems",
      date: "2018年 - 2020年",
      bullets: [
        {
          body: "Thesis: Scheduling interactive workloads across heterogeneous edge nodes.",
        },
      ],
    },
    {
      org: "江城大学",
      title: "工学学士",
      detail: "软件工程",
      date: "2014年 - 2018年",
      bullets: [
        {
          body: "主修数据结构、操作系统、数据库系统和软件工程实践，参与 ACM 校队训练与课程项目开发。",
        },
      ],
    },
  ],
  research: [
    {
      title: "Human-in-the-loop Code Review Study",
      date: "2024年",
      bullets: [
        {
          body: "设计实验流程比较 LLM review、人工 review 和 hybrid workflow 在缺陷发现率与误报率上的差异。",
        },
        {
          body: "整理评审日志和开发者反馈，形成 prompt guideline、review checklist 和定量分析报告。",
        },
      ],
    },
    {
      title: "Edge Cache Scheduling",
      date: "2019年 - 2020年",
      bullets: [
        {
          body: "基于 workload trace 构建调度模拟器，分析 cache locality 与 tail latency 之间的权衡。",
        },
        {
          body: "实现多种 baseline 策略并对比 p95/p99 latency、cache hit rate 和资源利用率。",
        },
      ],
    },
  ],
  publications: [
    {
      authors: "Lin Zhou, Emily Park, Wei Chen",
      title: "Type-Safe Workflow Orchestration for Internal AI Tools",
      venue: "ACM Symposium on Cloud Computing Workshop",
      year: "2024",
      url: "https://example.com/publications/workflow-orchestration",
    },
    {
      authors: "Wei Chen, Lin Zhou, Sara Ahmed",
      title: "Adaptive Edge Cache Scheduling with Mixed Workloads",
      venue: "IEEE ICWS",
      year: "2021",
      url: "",
    },
  ],
  additional: [
    {
      label: "开源协作",
      body: "维护 TypeScript utilities 和 internal CLI templates，偶尔向 React ecosystem 相关项目提交修复。",
    },
    {
      label: "语言能力",
      body: "中文母语；English 可用于 technical writing、design review 和跨时区协作。",
    },
  ],
};
