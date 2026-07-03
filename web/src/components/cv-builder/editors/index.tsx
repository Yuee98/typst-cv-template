"use client";

import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  horizontalListSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { useCallback, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { useFormContext, useWatch } from "react-hook-form";

import { Panel } from "@/components/ui/panel";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  DEFAULT_SECTION_ORDER,
  normalizeSectionOrder,
  type CvData,
  type CvSectionId,
} from "@/lib/cv/schema";
import { cn } from "@/lib/utils";

import { HeaderEditor } from "./header-editor";
import { SectionHeader, SelfNameField } from "./section-header";
import { TextItemsEditor } from "./text-items-editor";
import { SkillItemsEditor } from "./skill-items-editor";
import { ExperienceEditor } from "./experience-editor";
import { ResumeEntriesEditor } from "./education-editor";
import { OneLineEntriesEditor } from "./research-editor";
import { PublicationsEditor } from "./publications-editor";
import { FontSettingsEditor } from "./settings-editor";

type EditorTabId = "header" | "settings" | CvSectionId;

type SectionTab = {
  id: CvSectionId;
  label: string;
  content: ReactNode;
};

const sectionTabs: SectionTab[] = [
  {
    id: "profile",
    label: "Profile",
    content: (
      <div className="space-y-4">
        <SectionHeader name="profile" />
        <TextItemsEditor name="profile" addLabel="Add profile item" />
      </div>
    ),
  },
  {
    id: "skills",
    label: "Skills",
    content: (
      <div className="space-y-4">
        <SectionHeader name="skills" />
        <SkillItemsEditor name="skills" addLabel="Add skill" />
      </div>
    ),
  },
  {
    id: "experience",
    label: "Experience",
    content: (
      <div className="space-y-4">
        <SectionHeader name="experience" />
        <ExperienceEditor />
      </div>
    ),
  },
  {
    id: "education",
    label: "Education",
    content: (
      <div className="space-y-4">
        <SectionHeader name="education" />
        <ResumeEntriesEditor name="education" addLabel="Add education" />
      </div>
    ),
  },
  {
    id: "research",
    label: "Research",
    content: (
      <div className="space-y-4">
        <SectionHeader name="research" />
        <OneLineEntriesEditor name="research" addLabel="Add research" />
      </div>
    ),
  },
  {
    id: "publications",
    label: "Publications",
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
    label: "Additional",
    content: (
      <div className="space-y-4">
        <SectionHeader name="additional" />
        <SkillItemsEditor name="additional" addLabel="Add item" />
      </div>
    ),
  },
];

const sectionTabById = new Map(sectionTabs.map((tab) => [tab.id, tab]));

export function CvEditor({ actions }: { actions?: ReactNode }) {
  const { control, setValue } = useFormContext<CvData>();
  const watchedSectionOrder = useWatch({ control, name: "sectionOrder" });
  const sectionOrder = useMemo(
    () => normalizeSectionOrder(watchedSectionOrder ?? DEFAULT_SECTION_ORDER),
    [watchedSectionOrder],
  );
  const orderedSectionTabs = sectionOrder
    .map((sectionId) => sectionTabById.get(sectionId))
    .filter((tab): tab is SectionTab => Boolean(tab));
  const [activeTab, setActiveTab] = useState<EditorTabId>("header");
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 6,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  function moveSectionTab(fromIndex: number, toIndex: number) {
    const nextOrder = [...sectionOrder];
    const [moved] = nextOrder.splice(fromIndex, 1);
    if (!moved) {
      return;
    }

    nextOrder.splice(toIndex, 0, moved);
    setValue("sectionOrder", nextOrder, {
      shouldDirty: true,
      shouldTouch: true,
      shouldValidate: true,
    });
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) {
      return;
    }

    const fromIndex = sectionOrder.indexOf(String(active.id) as CvSectionId);
    const toIndex = sectionOrder.indexOf(String(over.id) as CvSectionId);
    if (fromIndex === -1 || toIndex === -1) {
      return;
    }

    moveSectionTab(fromIndex, toIndex);
  }

  return (
    <Panel title="Editor" actions={actions} className="editor-pane h-full min-h-[720px] overflow-hidden">
      <Tabs
        value={activeTab}
        onValueChange={(value) => setActiveTab(value as EditorTabId)}
        className="flex h-full min-h-0 flex-col"
      >
        <TabsList>
          <TabsTrigger value="header">Header</TabsTrigger>
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={sectionOrder} strategy={horizontalListSortingStrategy}>
              {orderedSectionTabs.map((tab) => (
                <SortableSectionTab key={tab.id} id={tab.id} label={tab.label} />
              ))}
            </SortableContext>
          </DndContext>
          <TabsTrigger value="settings">Settings</TabsTrigger>
        </TabsList>
        <div className="min-h-0 flex-1 overflow-auto">
          <TabsContent value="header">
            <HeaderEditor />
          </TabsContent>
          {sectionTabs.map((tab) => (
            <TabsContent key={tab.id} value={tab.id}>
              {tab.content}
            </TabsContent>
          ))}
          <TabsContent value="settings">
            <FontSettingsEditor />
          </TabsContent>
        </div>
      </Tabs>
    </Panel>
  );
}

function SortableSectionTab({ id, label }: { id: CvSectionId; label: string }) {
  const {
    attributes,
    isDragging,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
  } = useSortable({ id });
  const setRefs = useCallback(
    (node: HTMLButtonElement | null) => {
      setNodeRef(node);
      setActivatorNodeRef(node);
    },
    [setActivatorNodeRef, setNodeRef],
  );
  const dragAttributes = {
    "aria-describedby": attributes["aria-describedby"],
    "aria-roledescription": attributes["aria-roledescription"],
  };
  const style: CSSProperties = {
    transform: transform ? `translate3d(${transform.x}px, 0, 0)` : undefined,
    transition,
    zIndex: isDragging ? 20 : undefined,
  };

  return (
    <TabsTrigger
      ref={setRefs}
      value={id}
      style={style}
      className={cn("touch-none cursor-grab active:cursor-grabbing", isDragging && "opacity-70")}
      title="Drag to reorder section"
      {...dragAttributes}
      aria-label={`${label}. Drag to reorder section.`}
      {...listeners}
    >
      {label}
    </TabsTrigger>
  );
}
