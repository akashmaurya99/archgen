// Webview entry — mounts the React shell. Bundled to media/webview/main.js
// as a single IIFE (es2020) by esbuild.mjs.
import { createRoot } from 'react-dom/client';
import { App } from './App';

const container = document.getElementById('root');
if (!container) throw new Error('#root container missing from webview HTML');

createRoot(container).render(<App />);
