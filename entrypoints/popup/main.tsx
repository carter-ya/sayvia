import { createRoot } from 'react-dom/client';
import { PopupScreen } from '../../src/ui/PopupScreen';
import '../../src/ui/styles.css';
import { appearanceStyle } from '../../src/ui/appearance';

createRoot(document.getElementById('root')!).render(
  <>
    <style>{appearanceStyle}</style>
    <PopupScreen />
  </>,
);
