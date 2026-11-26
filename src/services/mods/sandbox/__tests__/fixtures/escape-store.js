export default async function () {
  const probes = [
    'window',
    'document',
    'process',
    'appState',
    'useAppStore',
    '__APP_STATE__',
  ];

  const visible = probes.filter((name) => typeof globalThis[name] !== 'undefined');
  const matchingGlobals = Object.getOwnPropertyNames(globalThis)
    .filter((name) => probes.includes(name));

  return { visible, matchingGlobals };
}

