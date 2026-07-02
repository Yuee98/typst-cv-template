#import "../style.typ": *

#resume-header(
  "Alex Chen",
  [Full-stack Developer | Product Engineering | Technical Lead],
  "alex.chen@example.com",
  "+1 555-0100",
)

#resume-section("Profile")
#plain-item[Full-stack developer with experience across frontend, backend, databases, delivery tooling, and production support.]
#plain-item[Regularly works on product requirements, technical design, code review, performance tuning, and engineering quality improvements.]

#resume-section("Technical Skills")
#skill-item("Frontend")[TypeScript, JavaScript, React, HTML/CSS, complex forms, reusable components]
#skill-item("Backend")[C\#, .NET, Web API, authorization, data aggregation, service integration]
#skill-item("Database")[SQL Server, T-SQL, query tuning, indexing, stored procedures]
#skill-item("Delivery")[Git, CI/CD, automated testing, code review, release support]

#resume-section("Experience")
#company-entry(
  "Example Technology",
  [2023 - Present],
)[
  #project-entry(
    [Senior Software Engineer],
    [Customer Platform],
    (
      [Led full-stack delivery for customer-facing workflows, including frontend screens, API integration, and database changes.],
      [Improved performance for selected workflows through request reduction, query tuning, caching, and batch loading.],
    ),
    date: [2023 - 2024],
  )
  #project-entry(
    [Senior Software Engineer],
    [Internal Engineering Platform],
    (
      [Supported release preparation, production investigation, code review, and onboarding for new team members.],
      [Maintained automation scripts and engineering conventions to reduce repeated work and improve delivery stability.],
    ),
  )
]

#resume-entry(
  "Example Software",
  [Software Engineer],
  [Internal Tools],
  [2020 - 2023],
  (
    [Built internal applications and automation scripts for operational teams.],
    [Maintained API services, database queries, and monitoring dashboards.],
  ),
)

#resume-section("Education")
#resume-entry(
  "Example University",
  [Master of Science],
  [Computer Science],
  [2018 - 2020],
  (),
)

#resume-section("Additional")
#skill-item("Languages")[English for professional communication and documentation.]
#skill-item("Interests")[Developer productivity, platform engineering, and practical automation.]
