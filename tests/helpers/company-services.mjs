import fs from 'node:fs/promises';
import path from 'node:path';
export async function configureCompanyServices(t, root, { teedyBaseUrl = 'https://library.fixture.test', canvasWebUrl = 'https://canvas.fixture.test' } = {}) {
  const file = path.join(root, 'fixture-company-services.json');
  await fs.writeFile(file, JSON.stringify({ schemaVersion: 1, teedy: { baseUrl: teedyBaseUrl }, canvas: { webUrl: canvasWebUrl } }));
  const previous = process.env.STUDIO_COMPANY_SERVICES_FILE;
  process.env.STUDIO_COMPANY_SERVICES_FILE = file;
  t.after(() => { if (previous === undefined) delete process.env.STUDIO_COMPANY_SERVICES_FILE; else process.env.STUDIO_COMPANY_SERVICES_FILE = previous; });
  return file;
}
