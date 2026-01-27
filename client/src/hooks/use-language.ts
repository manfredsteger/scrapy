import { useState, useEffect, useCallback } from 'react';
import { type Language, t as translate, type TranslationKey } from '@/lib/i18n';
import { apiRequest } from '@/lib/queryClient';

export function useLanguage() {
  const [language, setLanguageState] = useState<Language>('de');
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const savedLang = localStorage.getItem('language') as Language;
    if (savedLang && (savedLang === 'de' || savedLang === 'en')) {
      setLanguageState(savedLang);
    }
    setIsLoading(false);
  }, []);

  const setLanguage = useCallback((lang: Language) => {
    setLanguageState(lang);
    localStorage.setItem('language', lang);
    apiRequest('PUT', '/api/settings/language', { value: lang }).catch(() => {});
  }, []);

  const t = useCallback((key: TranslationKey) => {
    return translate(key, language);
  }, [language]);

  return { language, setLanguage, t, isLoading };
}
