import { createRoot } from 'react-dom/client';
import { SettingsScreen } from '../../src/ui/SettingsScreen';
import '../../src/ui/styles.css';
import { appearanceStyle } from '../../src/ui/appearance';

createRoot(document.getElementById('root')!).render(
  <>
    <style>{appearanceStyle}</style>
    <SettingsScreen />
  </>,
);
