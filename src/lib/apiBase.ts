/**
 * API base URL — protocol-aware for Electron production builds.
 *
 * In dev:  Vite proxies relative `/api/...` calls to http://localhost:3001
 * In prod: The React app is loaded via Electron's loadFile() (file:// protocol).
 *          Relative paths won't reach Express, so we use an absolute URL instead.
 */
export const API_BASE =
    typeof window !== 'undefined' && window.location.protocol === 'file:'
        ? 'http://localhost:3001/api'
        : '/api';

/**
 * Asset base URL for portrait images served by Express.
 * Same logic: relative paths break under file://, so use absolute in production.
 */
export const ASSET_BASE =
    typeof window !== 'undefined' && window.location.protocol === 'file:'
        ? 'http://localhost:3001'
        : '';
