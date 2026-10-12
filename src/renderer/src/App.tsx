import { useEffect } from 'react';
import { Sidebar } from './components/Sidebar';
import { GROUPS } from './lib/catalog';
import { About } from './pages/About';
import { Cleaner } from './pages/Cleaner';
import { Maintenance } from './pages/Maintenance';
import { Overview } from './pages/Overview';
import { Support } from './pages/Support';
import { Uninstaller } from './pages/Uninstaller';
import { useStore, type Route } from './state/store';

function Page({ route }: { route: Route }) {
  switch (route) {
    case 'overview':
      return <Overview />;
    case 'smart':
      return <Cleaner />;
    case 'uninstaller':
      return <Uninstaller />;
    case 'maintenance':
      return <Maintenance />;
    case 'support':
      return <Support />;
    case 'about':
      return <About />;
    default:
      return <Cleaner group={GROUPS.find((group) => group.route === route)!.group} />;
  }
}

export function App() {
  const route = useStore((state) => state.route);
  const locale = useStore((state) => state.locale);
  // A captura de tela (ferramenta de desenvolvimento) espera este sinal baixar.
  const busy = useStore((state) => state.system === null || state.scanning || state.appsLoading);

  useEffect(() => {
    void useStore.getState().init();
  }, []);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  useEffect(() => {
    document.documentElement.dataset.busy = busy ? '1' : '0';
  }, [busy]);

  return (
    <div className="app">
      <div className="app__drag" />
      <Sidebar />
      <main className="app__main" key={route}>
        <Page route={route} />
      </main>
    </div>
  );
}
