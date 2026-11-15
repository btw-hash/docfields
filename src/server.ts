import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { createPipeline } from './pipeline.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pipeline = createPipeline();
const app = createApp(pipeline, root);

const port = Number(process.env.PORT ?? 3470);
app.listen(port, () => {
  console.log(`docfields listening on http://localhost:${port} (${pipeline.mode})`);
});
