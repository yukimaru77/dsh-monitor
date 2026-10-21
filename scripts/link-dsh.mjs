// Development only: link the DSH packages this plugin imports from an installed
// DeepSeek Harness release into node_modules, so tests run without a download.
import { mkdir, readdir, realpath, rm, symlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const installation = resolve(process.argv[2] ?? process.env.DSH_INSTALL ?? join(dirname(await realpath(join(process.env.HOME, '.local/bin/dsh'))), '../../..'));
for (const scope of ['@deepseek-ai', '@earendil-works']) {
  await mkdir(join(root, 'node_modules', scope), { recursive: true });
  for (const name of await readdir(join(installation, scope))) {
    const destination = join(root, 'node_modules', scope, name);
    await rm(destination, { force: true });
    await symlink(join(installation, scope, name), destination);
  }
}
console.log(`Linked DSH packages from ${installation}`);
