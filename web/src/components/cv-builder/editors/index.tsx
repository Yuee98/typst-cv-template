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
} from "@dnd-kit/sortable";
import { useMemo, useState, type ReactNode } from "react";
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

import { buildSectionTabs, type SectionTab } from "./section-content";
import { reorderSectionOrder, writeSectionOrder } from "./section-order";
import { SortableSectionTab } from "./sortable-section-tab";
import { HeaderEditor } from "./header-editor";
import { FontSettingsEditor } from "./settings-editor";
import { isAiPolishUiEnabled } from "../polish/polish-entry";

type EditorTabId = "header" | "settings" | CvSectionId;

export function CvEditor({ actions }: { actions?: ReactNode }) {
  const t = useTranslations("Editors");
  // Feature-off builds must be layout-neutral: the actions prop itself is
  // omitted (not a truthy element that renders null), so SectionHeader keeps
  // its original column structure and no empty action slot appears.
  const polishUiEnabled = isAiPolishUiEnabled();
  const sectionTabs = buildSectionTabs(t, polishUiEnabled);
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

  function moveSectionTab(activeId: string, overId: string) {
    const nextOrder = reorderSectionOrder(sectionOrder, activeId, overId);
    if (!nextOrder) return;

    writeSectionOrder(setValue, nextOrder);
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

    moveSectionTab(String(active.id), String(over.id));
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
