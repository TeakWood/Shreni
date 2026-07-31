import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './components/App';
import './index.css';

const root = document.getElementById('root');
if (!root) throw new Error('Phalaka: #root not found');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
