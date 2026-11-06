import {build} from 'esbuild';
import {readFile,writeFile} from 'node:fs/promises';
await build({stdin:{contents:"export {tgpu,d} from 'typegpu';",resolveDir:process.cwd(),sourcefile:'typegpu-vendor.js'},bundle:true,format:'esm',platform:'browser',target:'es2022',minify:true,outfile:'dist/vendor/typegpu.js'});
const licenses=[];
for(const name of ['typegpu','typed-binary','tinyest','tsover-runtime'])licenses.push(name+'\n'+await readFile('node_modules/'+name+'/LICENSE','utf8'));
await writeFile('dist/vendor/TYPEGPU-LICENSES.txt',licenses.join('\n\n'));
