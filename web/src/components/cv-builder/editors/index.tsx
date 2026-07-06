"use client";

import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  horizontalListSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { useCallback, useMemo, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { useFormContext, useWatch } from "react-hook-form";
import { useTranslations } from "next-intl";

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

const tabNavigationKeysDuringDrag = new Set(["ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"]);

export function CvEditor({ actions }: { actions?: ReactNode }) {
  const t = useTranslations("Editors");
  const sectionTabs: SectionTab[] = [
    {
      id: "profile",
      label: t("tabs.profile"),
      content: (
        <div className="space-y-4">
          <SectionHeader name="profile" />
          <TextItemsEditor name="profile" addLabel={t("TextItems.add")} />
        </div>
      ),
    },
    {
      id: "skills",
      label: t("tabs.skills"),
      content: (
        <div className="space-y-4">
          <SectionHeader name="skills" />
          <SkillItemsEditor name="skills" addLabel={t("Skills.add")} />
        </div>
      ),
    },
    {
      id: "experience",
      label: t("tabs.experience"),
      content: (
        <div className="space-y-4">
          <SectionHeader name="experience" />
          <ExperienceEditor />
        </div>
      ),
    },
    {
      id: "education",
      label: t("tabs.education"),
      content: (
        <div className="space-y-4">
          <SectionHeader name="education" />
          <ResumeEntriesEditor name="education" addLabel={t("Education.add")} />
        </div>
      ),
    },
    {
      id: "research",
      label: t("tabs.research"),
      content: (
        <div className="space-y-4">
          <SectionHeader name="research" />
          <OneLineEntriesEditor name="research" addLabel={t("Research.add")} />
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
          <SectionHeader name="additional" />
          <SkillItemsEditor name="additional" addLabel={t("Additional.add")} />
        </div>
      ),
    },
  ];
  const sectionTabById = new Map(sectionTabs.map((tab) => [tab.id, tab]));

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
  const [draggingSectionTabId, setDraggingSectionTabId] = useState<CvSectionId | null>(null);
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

  function handleDragStart(event: DragStartEvent) {
    const activeId = String(event.active.id) as CvSectionId;
    if (sectionOrder.includes(activeId)) {
      setDraggingSectionTabId(activeId);
    }
  }

  function handleDragEnd(event: DragEndEvent) {
    setDraggingSectionTabId(null);

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

  function handleDragCancel() {
    setDraggingSectionTabId(null);
  }

  return (
    <Panel title={t("title")} actions={actions} className="editor-pane h-full overflow-hidden">
      <Tabs
        value={activeTab}
        onValueChange={(value) => setActiveTab(value as EditorTabId)}
        className="flex h-full min-h-0 flex-col"
      >
        <TabsList>
          <TabsTrigger value="header">{t("tabs.header")}</TabsTrigger>
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
            onDragCancel={handleDragCancel}
          >
            <SortableContext items={sectionOrder} strategy={horizontalListSortingStrategy}>
              {orderedSectionTabs.map((tab) => (
                <SortableSectionTab
                  key={tab.id}
                  id={tab.id}
                  label={tab.label}
                  keyboardDragActive={draggingSectionTabId === tab.id}
                />
              ))}
            </SortableContext>
          </DndContext>
          <TabsTrigger value="settings">{t("tabs.settings")}</TabsTrigger>
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

function SortableSectionTab({
  id,
  label,
  keyboardDragActive,
}: {
  id: CvSectionId;
  label: string;
  keyboardDragActive: boolean;
}) {
  const t = useTranslations("Editors");
  const {
    attributes,
    isDragging,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
  } = useSortable({ id });
  const { onKeyDown, ...dragListeners } = listeners ?? {};
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
  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>) => {
      onKeyDown?.(event);

      if (keyboardDragActive && tabNavigationKeysDuringDrag.has(event.key)) {
        event.preventDefault();
      }
    },
    [keyboardDragActive, onKeyDown],
  );

  return (
    <TabsTrigger
      ref={setRefs}
      value={id}
      style={style}
      className={cn("touch-none cursor-grab active:cursor-grabbing", isDragging && "opacity-70")}
      title={t("dragTitle")}
      {...dragAttributes}
      aria-label={t("aria.dragSection", { label })}
      {...dragListeners}
      onKeyDown={handleKeyDown}
    >
      {label}
    </TabsTrigger>
  );
}
