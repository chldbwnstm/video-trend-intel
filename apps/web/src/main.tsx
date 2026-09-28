import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import { App, preloadPageFor } from './App.tsx';

const root = document.getElementById('root');
if (!root) throw new Error('#root element missing in index.html');

// Fetch the current page's chunk now, in parallel with the dataset download (not after it).
preloadPageFor(window.location.hash);

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
