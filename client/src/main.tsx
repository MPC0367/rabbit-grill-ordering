import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/oswald';
import '@fontsource-variable/noto-sans-thai';
import '@fontsource-variable/cormorant-garamond';
import '@fontsource-variable/cormorant-garamond/wght-italic.css';
import './styles/tokens.css';
import './styles/base.css';
import './styles/components.css';
// styles/admin-kit.css (the staff kit) loads with the staff platform: see App.tsx.
import { App } from './App.tsx';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
