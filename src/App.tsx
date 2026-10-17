import { Library } from './components/Library';
import { Reader } from './components/Reader';
import { navigate, useHashRoute } from './lib/hooks';
import { useSettings } from './lib/settings';

export function App() {
  const route = useHashRoute();
  const [settings, updateSettings] = useSettings();

  if (route.view === 'read') {
    return <Reader key={route.id} id={route.id} settings={settings} updateSettings={updateSettings} onExit={() => navigate('#/')} />;
  }
  return <Library settings={settings} updateSettings={updateSettings} onOpen={(id) => navigate(`#/read/${id}`)} />;
}
