"use client";

import type { ReactNode } from "react";

import { Panel } from "@/components/ui/panel";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { HeaderEditor } from "./header-editor";
import { SectionHeader, SelfNameField } from "./section-header";
import { TextItemsEditor } from "./text-items-editor";
import { SkillItemsEditor } from "./skill-items-editor";
import { ExperienceEditor } from "./experience-editor";
import { ResumeEntriesEditor } from "./education-editor";
import { OneLineEntriesEditor } from "./research-editor";
import { PublicationsEditor } from "./publications-editor";
import { FontSettingsEditor } from "./settings-editor";

export function CvEditor({ actions }: { actions?: ReactNode }) {
  return (
    <Panel title="Editor" actions={actions} className="editor-pane h-full min-h-[720px] overflow-hidden">
      <Tabs defaultValue="header" className="flex h-full min-h-0 flex-col">
        <TabsList>
          <TabsTrigger value="header">Header</TabsTrigger>
          <TabsTrigger value="profile">Profile</TabsTrigger>
          <TabsTrigger value="skills">Skills</TabsTrigger>
          <TabsTrigger value="experience">Experience</TabsTrigger>
          <TabsTrigger value="education">Education</TabsTrigger>
          <TabsTrigger value="research">Research</TabsTrigger>
          <TabsTrigger value="publications">Publications</TabsTrigger>
          <TabsTrigger value="additional">Additional</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
        </TabsList>
        <div className="min-h-0 flex-1 overflow-auto">
          <TabsContent value="header">
            <HeaderEditor />
          </TabsContent>
          <TabsContent value="profile">
            <div className="space-y-4">
              <SectionHeader name="profile" />
              <TextItemsEditor name="profile" addLabel="Add profile item" />
            </div>
          </TabsContent>
          <TabsContent value="skills">
            <div className="space-y-4">
              <SectionHeader name="skills" />
              <SkillItemsEditor name="skills" addLabel="Add skill" />
            </div>
          </TabsContent>
          <TabsContent value="experience">
            <div className="space-y-4">
              <SectionHeader name="experience" />
              <ExperienceEditor />
            </div>
          </TabsContent>
          <TabsContent value="education">
            <div className="space-y-4">
              <SectionHeader name="education" />
              <ResumeEntriesEditor name="education" addLabel="Add education" />
            </div>
          </TabsContent>
          <TabsContent value="research">
            <div className="space-y-4">
              <SectionHeader name="research" />
              <OneLineEntriesEditor name="research" addLabel="Add research" />
            </div>
          </TabsContent>
          <TabsContent value="publications">
            <div className="space-y-4">
              <SectionHeader name="publications" />
              <SelfNameField />
              <PublicationsEditor name="publications" />
            </div>
          </TabsContent>
          <TabsContent value="additional">
            <div className="space-y-4">
              <SectionHeader name="additional" />
              <SkillItemsEditor name="additional" addLabel="Add item" />
            </div>
          </TabsContent>
          <TabsContent value="settings">
            <FontSettingsEditor />
          </TabsContent>
        </div>
      </Tabs>
    </Panel>
  );
}
