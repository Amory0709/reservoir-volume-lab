// Run before the stylesheet so the first painted frame uses the chosen theme.
(()=>{
  const key='reservoir-theme',root=document.documentElement;
  const system=window.matchMedia?.('(prefers-color-scheme: light)');
  const valid=value=>value==='light'||value==='dark';
  let preference;
  try{const saved=localStorage.getItem(key);if(valid(saved))preference=saved;}catch{}
  function apply(){
    const theme=preference??(system?.matches?'light':'dark'),lightMode=theme==='light';
    root.dataset.theme=theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content',lightMode?'#f8fafc':'#10161d');
    const button=document.getElementById('theme-toggle');
    if(button){
      const label=lightMode?'深色':'浅色';
      button.querySelector('.theme-label').textContent=label;
      button.querySelector('.theme-icon').textContent=lightMode?'☾':'☀';
      button.setAttribute('aria-label','切换至'+label+'模式');button.title='切换至'+label+'模式';
    }
    document.dispatchEvent(new CustomEvent('reservoir-theme-change',{detail:{lightMode}}));
  }
  apply();
  document.addEventListener('DOMContentLoaded',()=>{
    apply();
    document.getElementById('theme-toggle')?.addEventListener('click',()=>{
      preference=root.dataset.theme==='light'?'dark':'light';
      try{localStorage.setItem(key,preference);}catch{}
      apply();
    });
  },{once:true});
  system?.addEventListener('change',()=>{if(!preference)apply();});
  window.addEventListener('storage',event=>{
    if(event.key!==key&&event.key!==null)return;
    preference=valid(event.newValue)?event.newValue:undefined;apply();
  });
})();
