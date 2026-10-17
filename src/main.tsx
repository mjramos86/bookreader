import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { fontFaceCss } from './lib/fonts';
import './styles.css';

// Reading fonts are needed in the app shell too (the font picker previews each face).
const style = document.createElement('style');
style.textContent = fontFaceCss();
document.head.appendChild(style);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
