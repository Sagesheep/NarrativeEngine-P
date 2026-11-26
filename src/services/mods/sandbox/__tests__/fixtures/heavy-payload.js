export default async function () {
  const payload = 'x'.repeat(1024 * 1024);
  return { kind: 'heavy', bytes: payload.length, payload };
}

