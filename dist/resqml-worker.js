import {inspectEpc} from './resqml-package.js';
import {importResqmlGrid} from './resqml-import.js';
let pkg,files=[];
self.onmessage=async event=>{
  const {type,selection,limits}=event.data;
  try{
    if(type==='inspect'){
      files=event.data.files;const epcs=files.filter(f=>/\.epc$/i.test(f.name));
      if(epcs.length!==1)throw new Error('请同时选择一个 .epc 和它引用的 .h5 / .hdf5 文件。');
      if(epcs[0].size>128*1024*1024)throw new Error('EPC 超过 128 MB，请将大数组保存在外部 HDF5 中。');
      pkg=inspectEpc(new Uint8Array(await epcs[0].arrayBuffer()),files.filter(f=>/\.(h5|hdf5|hdf)$/i.test(f.name)));
      self.postMessage({type:'catalog',catalog:pkg.catalog});return;
    }
    if(type!=='load'||!pkg)throw new Error('请先选择 EPC 文件。');
    self.postMessage({type:'progress',fraction:0,phase:'准备 HDF5 读取器'});
    const h5=await import('./vendor/h5wasm/hdf5_hl.js'),{FS}=await h5.ready;
    const opened=new Map(),mounts=[];
    try{
      const openFile=file=>{
        if(opened.has(file))return opened.get(file);
        const dir='/resqml_'+mounts.length;FS.mkdir(dir);FS.mount(FS.filesystems.WORKERFS,{files:[file]},dir);mounts.push(dir);
        const handle=new h5.File(dir+'/'+file.name,'r');opened.set(file,handle);return handle;
      };
      const volume=importResqmlGrid(pkg,selection,openFile,(fraction,phase)=>self.postMessage({type:'progress',fraction,phase}),limits);
      self.postMessage({type:'ready',volume},['vertices','attributes','nodes','ranges','sortedPhi','columnPillars','kInterfaces'].map(k=>volume[k].buffer));
    }finally{for(const f of opened.values())f.close();for(const dir of mounts){FS.unmount(dir);FS.rmdir(dir);}}
  }catch(error){self.postMessage({type:'error',message:error.message||'RESQML 解析失败，请检查 EPC 与 HDF5 文件。'});}
};
