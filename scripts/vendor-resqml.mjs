import {build} from 'esbuild';
import {mkdir,cp,writeFile,readFile} from 'node:fs/promises';
await mkdir('dist/vendor',{recursive:true});
await build({stdin:{contents:"export {unzipSync,strFromU8} from 'fflate'; export {DOMParser} from '@xmldom/xmldom';",resolveDir:process.cwd(),sourcefile:'resqml-vendor.js'},bundle:true,format:'esm',platform:'browser',target:'es2020',minify:true,outfile:'dist/vendor/epc.js'});
await cp('node_modules/h5wasm/dist/esm','dist/vendor/h5wasm',{recursive:true});
const licenses=[];
for(const [name,path] of [['h5wasm','node_modules/h5wasm/LICENSE.txt'],['fflate','node_modules/fflate/LICENSE'],['@xmldom/xmldom','node_modules/@xmldom/xmldom/LICENSE']])licenses.push(name+'\n'+await readFile(path,'utf8'));
await writeFile('dist/vendor/LICENSES.txt',licenses.join('\n\n'));
