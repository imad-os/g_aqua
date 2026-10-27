import { createRoot } from 'react-dom/client';
import { TrainerApp } from './components/TrainerApp';
import './index.css';

const rootEl = document.getElementById('trainer-root') || document.getElementById('root');
if (rootEl) {
  createRoot(rootEl).render(<TrainerApp />);
}
