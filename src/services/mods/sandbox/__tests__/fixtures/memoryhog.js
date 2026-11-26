export default async function () {
  const chunks = [];
  while (true) {
    chunks.push(new Uint8Array(1024 * 1024));
  }
}

