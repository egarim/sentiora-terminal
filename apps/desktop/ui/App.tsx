import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, bootstrapFromLocation, subscribeEvents } from './lib/api';
import {
  insertSplit, leaf, leafIdsInOrder, leavesOf, newLeafId, removeLeaf, setRatio,
  type LayoutNode, type SplitDirection,
} from './lib/layout';
import type { PaneStatus } from './lib/useTerminalSession';
import type { Info, ResolvedAnimation, SessionDescriptor, Settings, Shell } from './lib/types';
import { applyTheme, resolveThemeId, watchSystemTheme, type ThemeId } from './theme';
import { matchShortcut, type ShortcutAction } from './lib/shortcuts';
import { TabBar } from './components/TabBar';
import { SplitPane } from './components/SplitPane';
import { TerminalView } from './components/TerminalView';
import { StatusBar } from './components/StatusBar';
import { SettingsPanel } from './components/SettingsPanel';
import { Onboarding } from './components/Onboarding';
import { ShortcutsDialog } from './components/ShortcutsDialog';

interface Tab {
  id: string;
  title: string;
  shellId: string;
  root: LayoutNode;
  activeLeafId: string;
}

interface Boot {
  stage: 'loading' | 'no-token' | 'ready' | 'error';
  message?: string;
}

let tabCounter = 0;

type FocusDirection = 'up' | 'down' | 'left' | 'right';

export function App() {
  const [boot, setBoot] = useState<Boot>({ stage: 'loading' });
  const [settings, setSettings] = useState<Settings | null>(null);
  const [settingsWarnings, setSettingsWarnings] = useState<string[]>([]);
  const [settingsPath, setSettingsPath] = useState('');
  const [shells, setShells] = useState<Shell[]>([]);
  const [info, setInfo] = useState<Info | null>(null);
  const [animation, setAnimation] = useState<ResolvedAnimation | null>(null);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [statuses, setStatuses] = useState<Record<string, PaneStatus>>({});
  const [descriptors, setDescriptors] = useState<Record<string, SessionDescriptor>>({});
  const [historyOpen, setHistoryOpen] = useState<Record<string, boolean>>({});
  const [showSettings, setShowSettings] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reducedMotion, setReducedMotion] = useState(false);

  const tabsRef = useRef<Tab[]>([]);
  tabsRef.current = tabs;

  const activeTab = tabs.find(tab => tab.id === activeTabId) ?? null;
  const focusedLeafId = activeTab?.activeLeafId ?? null;

  const themeId: ThemeId = resolveThemeId(settings?.appearance.themeSource ?? 'system');

  // ------------------------------------------------------------------ bootstrap
  useEffect(() => {
    const { token } = bootstrapFromLocation();
    if (!token) {
      setBoot({ stage: 'no-token' });
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const [loadedSettings, loadedShells, loadedInfo, loadedAnimation] = await Promise.all([
          api.getSettings(), api.shells(), api.info(), api.animation(),
        ]);
        if (cancelled) return;
        setSettings(loadedSettings.settings);
        setSettingsWarnings(loadedSettings.warnings);
        setSettingsPath(loadedSettings.path);
        setShells(loadedShells);
        setInfo(loadedInfo);
        setAnimation(loadedAnimation);
        setBoot({ stage: 'ready' });
      } catch (caught) {
        if (!cancelled) setBoot({ stage: 'error', message: (caught as Error).message });
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Create the first tab once settings and shells are known.
  const bootedRef = useRef(false);
  useEffect(() => {
    if (boot.stage !== 'ready' || !settings || bootedRef.current) return;
    bootedRef.current = true;
    if (!settings.onboarding.completed) return; // the onboarding screen launches the first tab
    const stored = settings.layout.restoreTabs ? settings.layout.tabs : [];
    if (stored.length === 0) {
      void openTab({ shellId: settings.shell.id === 'auto' ? undefined : settings.shell.id });
      return;
    }
    void (async () => {
      for (const entry of stored) {
        await openTab({ shellId: entry.shellId === 'auto' ? undefined : entry.shellId, title: entry.title });
      }
    })();
    // openTab is stable enough for a one-shot boot; re-running this on every
    // settings change would spawn duplicate tabs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boot.stage, settings]);

  // Follow the OS colour scheme and reduced-motion preference. Bumping a counter
  // is enough: the theme is recomputed from matchMedia during every render.
  const [, setMediaTick] = useState(0);
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => { setReducedMotion(media.matches); setMediaTick(tick => tick + 1); };
    update();
    media.addEventListener('change', update);
    const unwatch = watchSystemTheme(() => setMediaTick(tick => tick + 1));
    return () => { media.removeEventListener('change', update); unwatch(); };
  }, []);

  useEffect(() => { applyTheme(themeId); }, [themeId]);

  // The resolved animation flags depend on both the settings and the OS reduced
  // motion preference, so they are re-fetched whenever either changes.
  useEffect(() => {
    if (!settings) return;
    let cancelled = false;
    api.animation(reducedMotion).then(resolved => { if (!cancelled) setAnimation(resolved); }).catch(() => {});
    return () => { cancelled = true; };
  }, [settings, reducedMotion]);

  // Backend-level events: a lost host or a lost session has to reach the UI even
  // for panes that are not the focused one.
  useEffect(() => {
    if (boot.stage !== 'ready') return;
    const stop = subscribeEvents(name => {
      if (name === 'session-lost' || name === 'session-closed') void refreshInfo();
    }, { onError: () => setInfo(current => current) });
    return stop;
  }, [boot.stage]);

  const refreshInfo = useCallback(async () => {
    try {
      setInfo(await api.info());
    } catch {
      /* the status bar keeps showing the last known state */
    }
  }, []);

  // Hosts are recycled in the background, so the status bar polls rather than
  // pretending the view is live.
  useEffect(() => {
    if (boot.stage !== 'ready') return;
    const timer = window.setInterval(() => { void refreshInfo(); }, 5000);
    return () => window.clearInterval(timer);
  }, [boot.stage, refreshInfo]);

  // ------------------------------------------------------------------- sessions
  const registerDescriptor = useCallback((descriptor: SessionDescriptor) => {
    setDescriptors(current => ({ ...current, [descriptor.sessionId]: descriptor }));
  }, []);

  const openTab = useCallback(async ({ shellId, title, customPath }: { shellId?: string; title?: string; customPath?: string } = {}) => {
    setBusy(true);
    setError(null);
    try {
      const descriptor = await api.createSession({ shellId, customPath, label: title });
      registerDescriptor(descriptor);
      const leafId = newLeafId();
      tabCounter += 1;
      const tab: Tab = {
        id: `tab-${tabCounter}`,
        title: title ?? descriptor.label ?? `Tab ${tabCounter}`,
        shellId: descriptor.shellId ?? shellId ?? 'auto',
        root: leaf(descriptor.sessionId, leafId),
        activeLeafId: leafId,
      };
      setTabs(current => [...current, tab]);
      setActiveTabId(tab.id);
      return tab;
    } catch (caught) {
      setError((caught as Error).message);
      return null;
    } finally {
      setBusy(false);
    }
  }, [registerDescriptor]);

  const closeSession = useCallback(async (sessionId: string) => {
    try {
      await api.closeSession(sessionId);
    } catch {
      // A session that is already gone is not an error worth surfacing.
    }
  }, []);

  const mutateActiveTab = useCallback((fn: (tab: Tab) => Tab | null) => {
    setTabs(current => {
      const next: Tab[] = [];
      for (const tab of current) {
        if (tab.id !== activeTabId) { next.push(tab); continue; }
        const mutated = fn(tab);
        if (mutated) next.push(mutated);
      }
      return next;
    });
  }, [activeTabId]);

  const closePane = useCallback(async (leafId: string) => {
    const tab = tabsRef.current.find(entry => entry.id === activeTabId);
    if (!tab) return;
    const target = leavesOf(tab.root).find(entry => entry.leafId === leafId);
    const remaining = leavesOf(tab.root).filter(entry => entry.leafId !== leafId);
    const nextRoot = removeLeaf(tab.root, leafId);
    if (target) await closeSession(target.sessionId);
    setStatuses(current => {
      const next = { ...current };
      delete next[leafId];
      return next;
    });
    setHistoryOpen(current => {
      const next = { ...current };
      delete next[leafId];
      return next;
    });
    if (!nextRoot || remaining.length === 0) {
      setTabs(current => current.filter(entry => entry.id !== tab.id));
      setActiveTabId(() => {
        const rest = tabsRef.current.filter(entry => entry.id !== tab.id);
        return rest.length > 0 ? rest[rest.length - 1]!.id : null;
      });
      return;
    }
    mutateActiveTab(entry => ({
      ...entry,
      root: nextRoot,
      activeLeafId: entry.activeLeafId === leafId ? leafIdsInOrder(nextRoot)[0]! : entry.activeLeafId,
    }));
  }, [activeTabId, closeSession, mutateActiveTab]);

  const closeTab = useCallback(async (tabId: string) => {
    const tab = tabsRef.current.find(entry => entry.id === tabId);
    if (!tab) return;
    await Promise.all(leavesOf(tab.root).map(entry => closeSession(entry.sessionId)));
    setTabs(current => current.filter(entry => entry.id !== tabId));
    setActiveTabId(current => {
      if (current !== tabId) return current;
      const rest = tabsRef.current.filter(entry => entry.id !== tabId);
      return rest.length > 0 ? rest[rest.length - 1]!.id : null;
    });
  }, [closeSession]);

  const splitPane = useCallback(async (direction: SplitDirection) => {
    const tab = tabsRef.current.find(entry => entry.id === activeTabId);
    if (!tab) return;
    setBusy(true);
    setError(null);
    try {
      const descriptor = await api.createSession({
        shellId: tab.shellId === 'auto' ? undefined : tab.shellId,
        label: tab.title,
      });
      registerDescriptor(descriptor);
      const newLeafIdValue = newLeafId();
      mutateActiveTab(entry => ({
        ...entry,
        root: insertSplit(entry.root, entry.activeLeafId, direction, descriptor.sessionId),
        activeLeafId: newLeafIdValue,
      }));
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }, [activeTabId, mutateActiveTab, registerDescriptor]);

  // Panes are found spatially from their rendered rectangles rather than from the
  // tree, so Alt+Shift+Arrow matches what the user actually sees.
  const focusPane = useCallback((direction: FocusDirection) => {
    const panes = Array.from(document.querySelectorAll<HTMLElement>('[data-leaf-id]'))
      .map(element => ({ id: element.dataset.leafId!, rect: element.getBoundingClientRect(), element }));
    const current = panes.find(pane => pane.id === focusedLeafId);
    if (!current || panes.length < 2) return;
    const centre = (rect: DOMRect) => ({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
    const from = centre(current.rect);
    let best: { id: string; element: HTMLElement; score: number } | null = null;
    for (const pane of panes) {
      if (pane.id === current.id) continue;
      const to = centre(pane.rect);
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const aligned = direction === 'left' ? dx < -1
        : direction === 'right' ? dx > 1
          : direction === 'up' ? dy < -1 : dy > 1;
      if (!aligned) continue;
      const cross = direction === 'left' || direction === 'right' ? Math.abs(dy) : Math.abs(dx);
      const along = direction === 'left' || direction === 'right' ? -dx : -dy;
      const score = along + cross * 2;
      if (!best || score < best.score) best = { id: pane.id, element: pane.element, score };
    }
    if (!best) return;
    // xterm.js keeps its real input element in the DOM as a helper textarea.
    const input = best.element.querySelector<HTMLElement>('.xterm-helper-textarea') ?? best.element;
    input.focus();
    mutateActiveTab(entry => ({ ...entry, activeLeafId: best!.id }));
  }, [focusedLeafId, mutateActiveTab]);

  const selectTabByIndex = useCallback((index: number) => {
    const tab = tabsRef.current[index];
    if (tab) setActiveTabId(tab.id);
  }, []);

  const changeTab = useCallback((delta: number) => {
    const current = tabsRef.current;
    if (current.length === 0) return;
    const index = current.findIndex(tab => tab.id === activeTabId);
    const next = (index + delta + current.length) % current.length;
    setActiveTabId(current[next]!.id);
  }, [activeTabId]);

  const updateSettings = useCallback(async (patch: Partial<Settings>) => {
    try {
      const result = await api.putSettings(patch);
      setSettings(result.settings);
      setSettingsWarnings(result.warnings);
      const resolved = await api.animation(reducedMotion);
      setAnimation(resolved);
    } catch (caught) {
      setError((caught as Error).message);
    }
  }, [reducedMotion]);

  // Keep the restorable tab list in step with what is open, so a restart reopens
  // the same shells.
  useEffect(() => {
    if (!settings || !settings.onboarding.completed || !settings.layout.restoreTabs) return;
    const next = tabs.map(tab => ({ id: tab.id, title: tab.title, shellId: tab.shellId, splitDirection: 'horizontal' as const }));
    const previous = settings.layout.tabs;
    if (JSON.stringify(previous) === JSON.stringify(next)) return;
    void api.putSettings({ layout: { ...settings.layout, tabs: next } })
      .then(result => { setSettings(result.settings); })
      .catch(() => {});
  }, [tabs, settings]);

  // ------------------------------------------------------------------ shortcuts
  const runAction = useCallback((action: ShortcutAction) => {
    switch (action) {
      case 'newTab': void openTab({ shellId: settings?.shell.id === 'auto' ? undefined : settings?.shell.id }); break;
      case 'closePane': if (focusedLeafId) void closePane(focusedLeafId); break;
      case 'prevTab': changeTab(-1); break;
      case 'nextTab': changeTab(1); break;
      case 'splitRight': void splitPane('horizontal'); break;
      case 'splitDown': void splitPane('vertical'); break;
      case 'focusLeft': focusPane('left'); break;
      case 'focusRight': focusPane('right'); break;
      case 'focusUp': focusPane('up'); break;
      case 'focusDown': focusPane('down'); break;
      case 'toggleHistory':
        if (focusedLeafId) setHistoryOpen(current => ({ ...current, [focusedLeafId]: !current[focusedLeafId] }));
        break;
      case 'toggleSettings': setShowSettings(current => !current); break;
      case 'showShortcuts': setShowShortcuts(true); break;
    }
  }, [changeTab, closePane, focusPane, focusedLeafId, openTab, settings, splitPane]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // Alt+1..9 selects a tab. Browsers reserve Ctrl+number, not Alt+number.
      if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && /^[1-9]$/.test(event.key)) {
        event.preventDefault();
        selectTabByIndex(Number(event.key) - 1);
        return;
      }
      const shortcut = matchShortcut(event);
      if (!shortcut) {
        if (event.key === 'Escape') {
          if (showShortcuts) setShowShortcuts(false);
          else if (showSettings) setShowSettings(false);
        }
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      runAction(shortcut.action);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [runAction, selectTabByIndex, showSettings, showShortcuts]);

  const onStatus = useCallback((leafId: string, status: PaneStatus) => {
    setStatuses(current => {
      const previous = current[leafId];
      if (previous && previous.revision === status.revision && previous.state === status.state
        && previous.writeErrors === status.writeErrors && previous.backendLost === status.backendLost
        && previous.connected === status.connected && previous.cols === status.cols
        && previous.rows === status.rows && previous.lastError === status.lastError
        && previous.coalesced === status.coalesced && previous.scrollbackLines === status.scrollbackLines) {
        return current;
      }
      return { ...current, [leafId]: status };
    });
  }, []);

  const tabInfos = useMemo(() => tabs.map(tab => {
    const leaves = leavesOf(tab.root);
    const attention = leaves.some(entry => {
      const status = statuses[entry.leafId];
      return Boolean(status && (status.backendLost || status.writeErrors > 0));
    });
    return { id: tab.id, title: tab.title, paneCount: leaves.length, attention };
  }), [tabs, statuses]);

  const animationState = useMemo(() => {
    if (!animation) return 'off';
    if (!animation.enabled) return 'off';
    return animation.effectivePreset;
  }, [animation]);

  // --------------------------------------------------------------- boot screens
  if (boot.stage === 'no-token') {
    return (
      <main className="gate">
        <h1>Sentiora Living Terminal</h1>
        <p>
          This page was opened without a launch token. Start the backend and open the URL it prints:
        </p>
        <pre><code>node apps/desktop/bin/living-terminal.mjs</code></pre>
        <p className="hint">
          The token is delivered in the URL fragment so it never reaches a server log.
        </p>
      </main>
    );
  }

  if (boot.stage === 'loading') return <main className="gate"><p role="status">Connecting to the local bridge…</p></main>;

  if (boot.stage === 'error') {
    return (
      <main className="gate">
        <h1>Could not reach the bridge</h1>
        <p className="banner banner--fatal" role="alert">{boot.message}</p>
      </main>
    );
  }

  if (!settings) return <main className="gate"><p role="status">Loading settings…</p></main>;

  if (!settings.onboarding.completed) {
    return (
      <main className="gate">
        <Onboarding
          shells={shells}
          defaultShellId={settings.shell.id === 'auto' ? null : settings.shell.id}
          busy={busy}
          error={error}
          onLaunch={async choice => {
            const tab = await openTab(choice);
            if (tab) await updateSettings({ onboarding: { completed: true }, shell: { ...settings.shell, id: choice.shellId ?? 'custom' } });
          }}
        />
      </main>
    );
  }

  const renderLeaf = (leafId: string) => {
    const target = activeTab ? leavesOf(activeTab.root).find(entry => entry.leafId === leafId) : null;
    if (!target) return null;
    const descriptor = descriptors[target.sessionId] ?? null;
    return (
      <TerminalView
        key={leafId}
        leafId={leafId}
        sessionId={target.sessionId}
        label={descriptor?.label ?? 'terminal'}
        promptPattern={descriptor?.promptPattern ?? null}
        settings={settings}
        themeId={themeId}
        active={leafId === focusedLeafId}
        showHistory={historyOpen[leafId] === true}
        onStatus={onStatus}
        onFocusPane={id => mutateActiveTab(entry => ({ ...entry, activeLeafId: id }))}
        onToggleHistory={id => setHistoryOpen(current => ({ ...current, [id]: !current[id] }))}
        onClosePane={id => { void closePane(id); }}
      />
    );
  };

  return (
    <div
      className="app"
      data-animation={animationState === 'off' ? 'off' : 'on'}
      data-preset={animationState}
      // PR2: this is where the typed animation events (session.created,
      // command.finished, agent.stateChanged, ...) will drive the mascot state
      // machine. PR1 resolves and exposes the settings only; nothing animates.
      data-reduced-motion={reducedMotion ? 'true' : 'false'}
    >
      <TabBar
        tabs={tabInfos}
        activeTabId={activeTabId}
        onSelect={setActiveTabId}
        onClose={id => { void closeTab(id); }}
        onNew={() => { void openTab({ shellId: settings.shell.id === 'auto' ? undefined : settings.shell.id }); }}
      />

      <nav className="toolbar" aria-label="Workspace actions">
        <button type="button" className="button" onClick={() => { void openTab({ shellId: settings.shell.id === 'auto' ? undefined : settings.shell.id }); }}>New tab</button>
        <button type="button" className="button" onClick={() => { void splitPane('horizontal'); }} disabled={!activeTab}>Split right</button>
        <button type="button" className="button" onClick={() => { void splitPane('vertical'); }} disabled={!activeTab}>Split down</button>
        <button type="button" className="button" aria-pressed={showSettings} onClick={() => setShowSettings(current => !current)}>Settings</button>
        <button type="button" className="button" onClick={() => setShowShortcuts(true)}>Shortcuts</button>
      </nav>

      {error ? <p className="banner banner--fatal app__error" role="alert">{error}</p> : null}

      <div className="app__body">
        <main
          className="workspace"
          id={activeTab ? `tabpanel-${activeTab.id}` : undefined}
          role="tabpanel"
          aria-label={activeTab ? activeTab.title : 'No tab open'}
          tabIndex={-1}
        >
          {activeTab ? (
            <SplitPane
              node={activeTab.root}
              renderLeaf={renderLeaf}
              onRatio={(splitId, ratio) => mutateActiveTab(entry => ({ ...entry, root: setRatio(entry.root, splitId, ratio) }))}
            />
          ) : (
            <div className="empty">
              <p>No tab is open.</p>
              <button
                type="button"
                className="button button--primary"
                onClick={() => { void openTab({ shellId: settings.shell.id === 'auto' ? undefined : settings.shell.id }); }}
              >
                Open a terminal
              </button>
            </div>
          )}
        </main>

        {showSettings ? (
          <SettingsPanel
            settings={settings}
            warnings={settingsWarnings}
            path={settingsPath}
            shells={shells}
            animation={animation}
            onChange={patch => { void updateSettings(patch); }}
            onClose={() => setShowSettings(false)}
          />
        ) : null}
      </div>

      <StatusBar
        pane={focusedLeafId ? statuses[focusedLeafId] ?? null : null}
        descriptor={focusedLeafId && activeTab
          ? descriptors[leavesOf(activeTab.root).find(entry => entry.leafId === focusedLeafId)?.sessionId ?? ''] ?? null
          : null}
        info={info}
        animation={animation}
      />

      {showShortcuts ? <ShortcutsDialog onClose={() => setShowShortcuts(false)} /> : null}
    </div>
  );
}
