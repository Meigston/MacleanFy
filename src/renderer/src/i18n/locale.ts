export type Locale = 'pt-BR' | 'en';

export const LOCALES: Array<{ id: Locale; label: string }> = [
  { id: 'pt-BR', label: 'Português (Brasil)' },
  { id: 'en', label: 'English' },
];

const STORAGE_KEY = 'macleanfy.locale';

export function initialLocale(): Locale {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'pt-BR' || stored === 'en') return stored;
  } catch {
    // sem armazenamento, vale o idioma do sistema
  }
  return navigator.language.toLowerCase().startsWith('pt') ? 'pt-BR' : 'en';
}

export function persistLocale(locale: Locale): void {
  try {
    localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    // preferência só vale nesta sessão
  }
}
