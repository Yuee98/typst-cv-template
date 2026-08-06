import type { ReactNode } from "react";

import type { CvSectionId } from "@/lib/cv/schema";

import { ExperienceEditor } from "./experience-editor";
import { ResumeEntriesEditor } from "./education-editor";
import { OneLineEntriesEditor } from "./research-editor";
import { PublicationsEditor } from "./publications-editor";
import { SectionHeader, SelfNameField } from "./section-header";
import { SkillItemsEditor } from "./skill-items-editor";
import { TextItemsEditor } from "./text-items-editor";
import { PolishEntryButton } from "../polish/polish-entry-button";

export type SectionTab = {
  id: CvSectionId;
  label: string;
  content: ReactNode;
};


export type EditorTranslator = (key: string) => string;

export function buildSectionTabs(
  t: EditorTranslator,
  polishUiEnabled: boolean,
): SectionTab[] {
  return [
    {
      id: "profile",
      label: t("tabs.profile"),
      content: (
        <div className="space-y-4">
          <SectionHeader
            name="profile"
            actions={
              polishUiEnabled ? (
                // The whole profile is its "entry" granularity (capability
                // matrix: profile's entry level == its section level).
                <PolishEntryButton scope={{ sectionId: "profile", granularity: "entry" }} />
              ) : undefined
            }
          />
          <TextItemsEditor name="profile" addLabel={t("TextItems.add")} polish={{ sectionId: "profile" }} />
        </div>
      ),
    },
    {
      id: "skills",
      label: t("tabs.skills"),
      content: (
        <div className="space-y-4">
          <SectionHeader
            name="skills"
            actions={
              polishUiEnabled ? (
                <PolishEntryButton scope={{ sectionId: "skills", granularity: "section" }} />
              ) : undefined
            }
          />
          <SkillItemsEditor name="skills" addLabel={t("Skills.add")} polish={{ sectionId: "skills" }} />
        </div>
      ),
    },
    {
      id: "experience",
      label: t("tabs.experience"),
      content: (
        <div className="space-y-4">
          <SectionHeader
            name="experience"
            actions={
              polishUiEnabled ? (
                <PolishEntryButton scope={{ sectionId: "experience", granularity: "section" }} />
              ) : undefined
            }
          />
          <ExperienceEditor />
        </div>
      ),
    },
    {
      id: "education",
      label: t("tabs.education"),
      content: (
        <div className="space-y-4">
          <SectionHeader
            name="education"
            actions={
              polishUiEnabled ? (
                <PolishEntryButton scope={{ sectionId: "education", granularity: "section" }} />
              ) : undefined
            }
          />
          <ResumeEntriesEditor
            name="education"
            addLabel={t("Education.add")}
            polishSectionId="education"
          />
        </div>
      ),
    },
    {
      id: "research",
      label: t("tabs.research"),
      content: (
        <div className="space-y-4">
          <SectionHeader
            name="research"
            actions={
              polishUiEnabled ? (
                <PolishEntryButton scope={{ sectionId: "research", granularity: "section" }} />
              ) : undefined
            }
          />
          <OneLineEntriesEditor
            name="research"
            addLabel={t("Research.add")}
            polishSectionId="research"
          />
        </div>
      ),
    },
    {
      id: "publications",
      label: t("tabs.publications"),
      content: (
        <div className="space-y-4">
          <SectionHeader name="publications" />
          <SelfNameField />
          <PublicationsEditor name="publications" />
        </div>
      ),
    },
    {
      id: "additional",
      label: t("tabs.additional"),
      content: (
        <div className="space-y-4">
          <SectionHeader
            name="additional"
            actions={
              polishUiEnabled ? (
                <PolishEntryButton scope={{ sectionId: "additional", granularity: "section" }} />
              ) : undefined
            }
          />
          <SkillItemsEditor
            name="additional"
            addLabel={t("Additional.add")}
            polish={{ sectionId: "additional" }}
          />
        </div>
      ),
    },
  ];
}
