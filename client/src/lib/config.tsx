// Public restaurant configuration (/api/public/config), loaded once and kept fresh.
import { createContext, useContext, type ReactNode } from 'react';
import type { PublicConfigDTO } from '../../../shared/dto.ts';
import { useResource } from './live.tsx';

interface ConfigApi {
  config: PublicConfigDTO | undefined;
  refresh: () => Promise<void>;
  error: boolean;
}

const ConfigContext = createContext<ConfigApi>({ config: undefined, refresh: async () => {}, error: false });

export function ConfigProvider({ children }: { children: ReactNode }) {
  const r = useResource<PublicConfigDTO>('/api/public/config', { topics: ['ordering.', 'settings.'], intervalMs: 60_000 });
  return <ConfigContext.Provider value={{ config: r.data, refresh: r.refresh, error: Boolean(r.error) }}>{children}</ConfigContext.Provider>;
}

export function useConfig(): ConfigApi {
  return useContext(ConfigContext);
}
