import type { Setting, SettingDefinitionItem, SettingDefinitionRender } from "obsidian";

export type KordocSettingRow =
  | { kind: "heading"; name: string }
  | { kind: "setting"; name: string; desc?: string; build: (setting: Setting) => void }
  | { kind: "footer"; name: string; render: (container: HTMLElement) => void };

export function buildSettingDefinitions(
  rows: readonly KordocSettingRow[],
  fallbackHeading: string,
): SettingDefinitionItem[] {
  const items: SettingDefinitionItem[] = [];
  let currentGroup: { type: "group"; heading: string; items: SettingDefinitionRender[] } | undefined;

  for (const row of rows) {
    if (row.kind === "heading") {
      currentGroup = { type: "group", heading: row.name, items: [] };
      items.push(currentGroup);
      continue;
    }
    if (row.kind === "footer") {
      items.push({
        name: row.name,
        searchable: false,
        render: (setting: Setting) => {
          setting.setName(row.name);
          setting.settingEl.empty();
          row.render(setting.settingEl);
        },
      });
      continue;
    }
    if (!currentGroup) {
      currentGroup = { type: "group", heading: fallbackHeading, items: [] };
      items.push(currentGroup);
    }
    currentGroup.items.push({
      name: row.name,
      ...(row.desc === undefined ? {} : { desc: row.desc }),
      render: (setting) => {
        setting.setName(row.name);
        if (row.desc !== undefined) setting.setDesc(row.desc);
        row.build(setting);
      },
    });
  }

  return items;
}
