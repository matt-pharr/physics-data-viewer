import React from 'react';
import { ModulePanel } from '../../api/client';

interface ModulePanelProps {
  panel: ModulePanel;
  onRefresh?: (panelId: string) => void;
}

interface PanelSection {
  title?: string;
  body?: string;
  items?: { label: string; value: string }[];
}

const renderSections = (content: any) => {
  const sections: PanelSection[] = Array.isArray(content?.sections) ? content.sections : [];
  if (!sections.length) {
    return null;
  }

  return sections.map((section, idx) => (
    <div className="module-panel-section" key={`${section.title ?? 'section'}-${idx}`}>
      {section.title && <div className="module-panel-section__title">{section.title}</div>}
      {section.body && <div className="module-panel-section__body">{section.body}</div>}
      {Array.isArray(section.items) && section.items.length > 0 && (
        <dl className="module-panel-items">
          {section.items.map((item, itemIdx) => (
            <div className="module-panel-item" key={`${item.label}-${itemIdx}`}>
              <dt>{item.label}</dt>
              <dd>{item.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  ));
};

export const ModulePanelCard: React.FC<ModulePanelProps> = ({ panel, onRefresh }) => {
  const sections = renderSections(panel.content);
  const extraContentKeys = Object.keys(panel.content || {}).filter((key) => key !== 'sections');

  return (
    <div className="module-panel-card" data-testid="module-panel">
      <div className="module-panel-card__header">
        <div className="module-panel-card__title-block">
          <div className="module-panel-card__title">{panel.title}</div>
          <div className="module-panel-card__meta">from {panel.module}</div>
        </div>
        <div className="module-panel-card__actions">
          {onRefresh && (
            <button className="action-button" onClick={() => onRefresh(panel.panel_id)}>
              Refresh
            </button>
          )}
          <span className="module-panel-card__timestamp">
            Updated {new Date(panel.updated_at * 1000).toLocaleTimeString()}
          </span>
        </div>
      </div>
      {panel.description && <p className="module-panel-card__description">{panel.description}</p>}
      {sections}
      {extraContentKeys.length > 0 && (
        <pre className="module-panel-card__json">{JSON.stringify(panel.content, null, 2)}</pre>
      )}
    </div>
  );
};
