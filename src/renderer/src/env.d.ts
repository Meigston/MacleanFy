/// <reference types="vite/client" />
import type { MacleanFyApi } from '../../shared/api';

declare global {
  interface Window {
    macleanfy: MacleanFyApi;
  }
}
