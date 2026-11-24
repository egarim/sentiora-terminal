interface TabInfo {
  id: string;
  title: string;
  paneCount: number;
  /** True when any pane in the tab needs attention (lost backend, lost input). */
  attention: boolean;
}

interface Props {
  tabs: TabInfo[];
  activeTabId: string | null;
  onSelect: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onNew: () => void;
}

/** Tab strip. A real tablist, so arrow keys and screen readers behave as expected. */
export function TabBar({ tabs, activeTabId, onSelect, onClose, onNew }: Props) {
  return (
    <div className="tabbar">
      <div className="tabbar__list" role="tablist" aria-label="Terminal tabs">
        {tabs.map((tab, index) => (
          <div
            key={tab.id}
            role="tab"
            id={`tab-${tab.id}`}
            aria-selected={tab.id === activeTabId}
            aria-controls={`tabpanel-${tab.id}`}
            aria-label={`${tab.title}, ${tab.paneCount} pane${tab.paneCount === 1 ? '' : 's'}${tab.attention ? ', needs attention' : ''}, tab ${index + 1} of ${tabs.length}`}
            tabIndex={tab.id === activeTabId ? 0 : -1}
            className={`tab${tab.id === activeTabId ? ' tab--active' : ''}${tab.attention ? ' tab--attention' : ''}`}
            onClick={() => onSelect(tab.id)}
            onKeyDown={event => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onSelect(tab.id);
              }
            }}
          >
            {tab.attention ? <span className="tab__dot" aria-hidden="true" /> : null}
            <span className="tab__title">{tab.title}</span>
            <span className="tab__panes">{tab.paneCount > 1 ? tab.paneCount : ''}</span>
            <button
              type="button"
              className="tab__close"
              aria-label={`Close tab ${tab.title}`}
              // The tab itself is the click target for selection, so the close
              // button must not also select it.
              onClick={event => { event.stopPropagation(); onClose(tab.id); }}
            >
              ×
            </button>
          </div>
        ))}
      </div>
      <button type="button" className="button button--ghost tabbar__new" onClick={onNew} title="New tab (Alt+T)">
        + New tab
      </button>
    </div>
  );
}
