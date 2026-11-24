import { createRoot } from 'react-dom/client';
import '@xterm/xterm/css/xterm.css';
import './styles/app.css';
import { App } from './App';
import { applyTheme, resolveThemeId } from './theme';

// StrictMode is deliberately not used here. Its double-invoked effects would
// create and immediately dispose an xterm.js instance and its stream subscription
// per pane, which buys nothing for a terminal and makes teardown races look like
// application bugs.

const container = document.getElementById('root');
if (!container) throw new Error('the root element is missing from index.html');

// Applied before the first render so the initial paint is already themed and
// there is no unstyled flash.
applyTheme(resolveThemeId('system'));

createRoot(container).render(<App />);
