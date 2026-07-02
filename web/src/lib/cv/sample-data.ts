import type { CvData } from "./schema";

export const sampleCvData: CvData = {
  schemaVersion: 5,
  typstLang: "zh",
  header: {
    name: "陈明",
    subtitle: "全栈开发工程师 | 产品工程 | 技术负责人",
    email: "alex.chen@example.com",
    phone: "+1 555-0100",
    selfName: "Ming Chen",
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
      body: "全栈开发工程师，具备前端、后端、数据库、交付工具和线上支持经验，能够参与从需求分析到功能上线的完整研发流程。",
    },
    {
      body: "日常负责产品需求拆解、技术方案设计、代码评审、性能优化、工程质量改进和团队协作支持。",
    },
  ],
  skills: [
    {
      label: "前端开发",
      body: "TypeScript、JavaScript、React、HTML/CSS、复杂表单、可复用组件",
    },
    {
      label: "后端开发",
      body: "C#、.NET、Web API、权限校验、数据聚合、服务集成",
    },
    {
      label: "数据库",
      body: "SQL Server、T-SQL、查询优化、索引设计、存储过程",
    },
    {
      label: "工程交付",
      body: "Git、CI/CD、自动化测试、代码评审、发布支持",
    },
  ],
  experience: [
    {
      org: "示例科技有限公司",
      date: "2023年 - 至今",
      projects: [
        {
          title: "高级软件工程师",
          detail: "客户业务平台",
          date: "2023年 - 2024年",
          bullets: [
            {
              body: "负责面向客户业务流程的全栈交付，覆盖前端页面、API 集成和数据库变更。",
            },
            {
              body: "通过减少请求数量、优化查询、增加缓存和批量加载等方式改进关键流程性能。",
            },
          ],
        },
        {
          title: "高级软件工程师",
          detail: "内部工程平台",
          date: "",
          bullets: [
            {
              body: "参与发布准备、线上问题排查、代码评审和新人引导，推动团队工程实践落地。",
            },
            {
              body: "维护自动化脚本和工程规范，帮助团队减少重复操作并提升交付稳定性。",
            },
          ],
        },
      ],
    },
    {
      org: "示例软件有限公司",
      date: "2020年 - 2023年",
      projects: [
        {
          title: "软件工程师",
          detail: "内部工具平台",
          date: "",
          bullets: [
            {
              body: "为运营团队构建内部应用和自动化脚本，提升日常处理效率。",
            },
            {
              body: "维护 API 服务、数据库查询和监控看板，支持稳定的内部工具运行。",
            },
          ],
        },
      ],
    },
  ],
  education: [
    {
      org: "示例大学",
      title: "理学硕士",
      detail: "计算机科学",
      date: "2018年 - 2020年",
      bullets: [],
    },
  ],
  research: [],
  publications: [
    {
      authors: "Ming Chen, John Doe, Jane Smith",
      title: "Scalable Micro-Frontend Architecture for Large-Scale SPAs",
      venue: "IEEE International Conference on Web Services",
      year: "2023",
      url: "https://doi.org/10.1109/ICWS.2023.00012",
    },
  ],
  additional: [
    {
      label: "语言能力",
      body: "英语可用于工作沟通、技术文档和跨团队协作。",
    },
    {
      label: "关注方向",
      body: "开发者效率、平台工程和实用自动化。",
    },
  ],
};
