export default async function () {
  if (typeof fetch !== 'function') {
    return { network: 'fetch-undefined' };
  }

  try {
    fetch('https://example.com/');
    return { network: 'fetch-call-returned' };
  } catch (error) {
    return { network: 'blocked', error: String(error) };
  }
}

