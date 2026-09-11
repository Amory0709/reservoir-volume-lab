// Exercise the shipped worker and browser HDF5 bundle without a browser/DOM.
// FileReaderSync is a minimal local-file adapter; WORKERFS, WASM and parser are real.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
const root=resolve(process.argv[2]),expected=JSON.parse(readFileSync(root+'/expected.json'));
let reads=0;const messages=[];
class InputFile{
  constructor(name,data){this.name=name;this.data=data;this.size=data.byteLength;}
  async arrayBuffer(){assert(this.name.endsWith('.epc'),'HDF5 must be read lazily through WORKERFS');return this.data.buffer.slice(this.data.byteOffset,this.data.byteOffset+this.size);}
  slice(start,end){return new InputFile(this.name,this.data.subarray(start,end));}
}
globalThis.WorkerGlobalScope=class{};
globalThis.FileReaderSync=class{readAsArrayBuffer(file){reads++;return file.data.buffer.slice(file.data.byteOffset,file.data.byteOffset+file.size);}};
globalThis.self={postMessage:(message,transfer=[])=>messages.push(structuredClone(message,{transfer}))};
await import('./dist/resqml-worker.js');
const files=['reference.epc','reference.h5'].map(n=>new InputFile(n,readFileSync(root+'/'+n)));
await self.onmessage({data:{type:'inspect',files}});assert.equal(messages.at(-1).type,'catalog');
const item=expected[1];await self.onmessage({data:{type:'load',selection:{grid:item.grid,...item.properties,phiUnit:'auto'},limits:{max3d:2048,max2d:4096}}});
const result=messages.at(-1);assert.equal(result.type,'ready',result.message);assert.equal(result.volume.stats.activeCells,44);assert(result.volume.vertices.byteLength>0);assert(reads>0);
const h5=await import('./dist/vendor/h5wasm/hdf5_hl.js'),{FS}=await h5.ready;assert(!FS.readdir('/').some(n=>n.startsWith('resqml_')),'Mounted user files leaked after parsing');
console.log('PASS shipped worker: EPC inspection, lazy WORKERFS reads, browser HDF5 WASM, compressed properties, transfer and cleanup',{reads,cells:result.volume.stats.cells});
