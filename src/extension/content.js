(()=>{
  if (window.__T48__) return; // singleton

  const DIRS = ['Up','Right','Down','Left'];
  const KEYCODES = [38,39,40,37];

  // --- Shadow root HUD ---
  const host = document.createElement('div');
  host.id = 't48-host';
  host.style.cssText = 'position:fixed;top:16px;right:16px;z-index:2147483647;pointer-events:auto;';
  const root = host.attachShadow({mode:'open'});
  const style = document.createElement('style');
  style.textContent = `
  .card{font:13px/1.4 ui-sans-serif,system-ui,Segoe UI,Roboto,Arial; color:#111; background:#fff;border:1px solid #e5e7eb;border-radius:12px;box-shadow:0 6px 20px rgba(0,0,0,.12);width:260px;overflow:hidden}
  .hdr{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;background:#f8fafc;border-bottom:1px solid #e5e7eb;cursor:move}
  .btn{border:1px solid #d1d5db;background:#f9fafb;border-radius:8px;padding:6px 10px;margin:6px 8px;cursor:pointer}
  .btn[data-on="1"]{background:#e6ffe6;border-color:#86efac}
  .row{display:flex;gap:6px;flex-wrap:wrap;padding:8px}
  .muted{color:#6b7280;font-size:12px;padding:0 8px 8px}
  select.btn{appearance:auto}
  `;
  root.appendChild(style);
  const wrap = document.createElement('div');
  wrap.className = 'card';
  wrap.innerHTML = `
    <div class="hdr"><strong>2048 HUD</strong><span id="t48-close" style="cursor:pointer">✕</span></div>
    <div class="row">
      <button class="btn" id="t48-detect">Detect</button>
      <button class="btn" id="t48-solve">Auto‑solve</button>
      <button class="btn" id="t48-step">Step</button>
      <select class="btn" id="t48-pri" title="Preferred direction bias">
        <option value="2">Corner: Down→Right</option>
        <option value="1">Corner: Right→Down</option>
        <option value="3">Corner: Left→Down</option>
        <option value="0">Corner: Up→Right</option>
      </select>
    </div>
    <div class="muted" id="t48-log">Idle.</div>`;
  root.appendChild(wrap);
  document.documentElement.appendChild(host);

  // Dragging
  (function(){
    const hdr = wrap.querySelector('.hdr');
    let ox, oy, dragging=false;
    hdr.addEventListener('pointerdown',e=>{dragging=true;ox=e.clientX-host.offsetLeft;oy=e.clientY-host.offsetTop;hdr.setPointerCapture(e.pointerId)});
    hdr.addEventListener('pointermove',e=>{if(!dragging)return;host.style.left=(e.clientX-ox)+"px";host.style.top=(e.clientY-oy)+"px";host.style.right='auto';});
    hdr.addEventListener('pointerup',()=>dragging=false);
  })();

  const log = (m)=> root.getElementById('t48-log').textContent = m;
  root.getElementById('t48-close').onclick = ()=> host.remove();

  // --- Adapter interface ---
  // Adapter = { canAttach():boolean, readBoard(): number[][] | null, sendMove(dir:0|1|2|3): void }
  /** @type {Array<{canAttach:()=>boolean, readBoard:()=>number[][]|null, sendMove:(d:0|1|2|3)=>void}>} */
  const adapters = [];

  // Helper: dispatch arrow key and a swipe gesture for mobile-only clones
  function dispatchMove(dir){
    const key = new KeyboardEvent('keydown',{key:DIRS[dir], keyCode:KEYCODES[dir], which:KEYCODES[dir], bubbles:true});
    const target = document.activeElement || document.body || document.documentElement;
    target.dispatchEvent(key);

    // Synthetic swipe (touch) as fallback
    try {
      const center = {x: window.innerWidth/2, y: window.innerHeight/2};
      const delta = [ {x:0,y:-120}, {x:120,y:0}, {x:0,y:120}, {x:-120,y:0} ][dir];
      const start = new Touch({identifier:1, target:document.elementFromPoint(center.x, center.y) || document.body, clientX:center.x, clientY:center.y});
      const end = new Touch({identifier:1, target:document.elementFromPoint(center.x+delta.x, center.y+delta.y) || document.body, clientX:center.x+delta.x, clientY:center.y+delta.y});
      const ts = (type, touches)=> new TouchEvent(type,{bubbles:true,cancelable:true, composed:true, touches, targetTouches:touches, changedTouches:touches});
      const rootEl = document.elementFromPoint(center.x, center.y) || document.body;
      rootEl.dispatchEvent(ts('touchstart',[start]));
      rootEl.dispatchEvent(ts('touchmove',[end]));
      rootEl.dispatchEvent(ts('touchend',[end]));
    } catch {}
  }

  // Adapter A: Original 2048 (play2048‑style) — tiles have classes like tile tile-2 tile-position-1-1
  adapters.push({
    canAttach(){ return !!document.querySelector('.tile-container .tile, .tile-container .tile-new, .tile-container .tile-merged'); },
    readBoard(){
      const container = document.querySelector('.tile-container');
      if(!container) return null;
      const cells = Array.from({length:4},()=>Array(4).fill(0));
      container.querySelectorAll('.tile').forEach(el=>{
        const cls = el.className;
        const vMatch = cls.match(/tile-(\d+)/);
        const pMatch = cls.match(/tile-position-(\d+)-(\d+)/);
        if(vMatch && pMatch){
          const v = +vMatch[1];
          const r = (+pMatch[2])-1; // row (y)
          const c = (+pMatch[1])-1; // col (x)
          cells[r][c] = Math.max(cells[r][c], v); // keep highest tile if stacked
        }
      });
      return cells;
    },
    sendMove(dir){ dispatchMove(dir); }
  });

  // Adapter B: Generic numeric grid — finds 4x4 of visible numbers (2^n). Simplistic.
  adapters.push({
    canAttach(){
      const nums = Array.from(document.querySelectorAll('div,span,p,td'))
        .filter(el=>el.offsetParent && /^(2|4|8|16|32|64|128|256|512|1024|2048)$/.test(el.textContent.trim()));
      return nums.length >= 8; // heuristic
    },
    readBoard(){
      const candidates = Array.from(document.querySelectorAll('div,span,p,td'))
        .filter(el=>el.offsetParent && /^(2|4|8|16|32|64|128|256|512|1024|2048)$/.test(el.textContent.trim()))
        .map(el=>({el, r: el.getBoundingClientRect()}));
      if(candidates.length<4) return null;
      const xs = [...new Set(candidates.map(c=>Math.round(c.r.left)))].sort((a,b)=>a-b);
      const ys = [...new Set(candidates.map(c=>Math.round(c.r.top)))].sort((a,b)=>a-b);
      if(xs.length<2 || ys.length<2) return null;
      const cluster = (vals)=>{
        const res=[]; vals.forEach(v=>{const last=res[res.length-1]; if(!last||Math.abs(last.avg-v)>30) res.push({sum:v,count:1,avg:v}); else {last.sum+=v;last.count++;last.avg=Math.round(last.sum/last.count);} });
        return res.map(o=>o.avg).slice(0,4);
      };
      const cols = cluster(xs); const rows = cluster(ys);
      if(cols.length<4 || rows.length<4) return null;
      const grid = Array.from({length:4},()=>Array(4).fill(0));
      candidates.forEach(({el,r})=>{
        const val = +el.textContent.trim();
        let ci = cols.findIndex(x=>Math.abs(x - Math.round(r.left))<30);
        let ri = rows.findIndex(y=>Math.abs(y - Math.round(r.top))<30);
        if(ci>=0 && ri>=0) grid[ri][ci] = Math.max(grid[ri][ci], val);
      });
      return grid;
    },
    sendMove(dir){ dispatchMove(dir); }
  });

  // --- Core runtime ---
  let adapter = null, running=false;
  const hash = (m)=> m? m.flat().join(',') : '';

  function detect(){
    adapter = null;
    for(const a of adapters){ if(a.canAttach()){ adapter=a; break; } }
    log(adapter? 'Adapter attached.' : 'No board found.');
    return !!adapter;
  }

  function read(){ return adapter?.readBoard()||null; }
  function send(dir){ adapter?.sendMove(dir); }

  function pickOrder(){ // naive priority with small backoff
    const order = [0,1,2,3]; // Up,Right,Down,Left
    const start = +root.getElementById('t48-pri').value; // bias
    return [start, ...order.filter(d=>d!==start)];
  }

  function tick(){
    if(!running) return;
    if(document.visibilityState !== 'visible'){ setTimeout(tick, 250); return; }
    const before = hash(read());
    const tryOrder = pickOrder();
    let moved=false;
    (async()=>{
      for(const d of tryOrder){
        send(d);
        await new Promise(r=>setTimeout(r,130));
        const after = hash(read());
        if(after && after!==before){ moved=true; log(`Move: ${DIRS[d]}`); break; }
      }
      if(!moved){ log('No move changed board; randomizing.'); send(Math.floor(Math.random()*4)); }
      setTimeout(tick, 130);
    })();
  }

  // Bind UI
  root.getElementById('t48-detect').onclick = ()=> detect();
  root.getElementById('t48-step').onclick = ()=>{ if(!adapter && !detect()) return; const d = pickOrder()[0]; send(d); };
  root.getElementById('t48-solve').onclick = (ev)=>{
    if(!adapter && !detect()) return;
    running = !running; ev.currentTarget.dataset.on = running? '1':'0';
    log(running? 'Auto‑solve running…' : 'Stopped.');
    if(running) tick();
  };

  window.__T48__ = { toggle(){ host.style.display = host.style.display==='none'?'':'none'; }, remove(){ host.remove(); }, detect };
})();

