// Add microphone voice input via a client-side injection script.
// Instead of patching the minified webpack chunk (which is fragile), this
// approach injects a <script> tag into index.html that runs after the app
// loads and adds a mic button to the prompt bar toolbar dynamically.
//
// The script:
// 1. Waits for the composer toolbar to appear (MutationObserver)
// 2. Inserts a mic button next to the Tools button
// 3. Uses the Web Speech API (webkitSpeechRecognition) for voice-to-text
// 4. When recording: the mic button turns red and pulses
// 5. Recognized text is inserted into the tiptap/ProseMirror composer
const fs = require('fs');
const crypto = require('crypto');

const DIST = process.env.LUMO_DIST_DIR || '/home/z/my-project/LumoOS/lumo-dist';
const STATIC = `${DIST}/assets/static`;
const VERSION = 'v=55';
const sri = (buf) => 'sha384-' + crypto.createHash('sha384').update(buf).digest('base64');

// ── 1. Write the mic injection script as a separate JS file ─────────────────
const MIC_SCRIPT = `(function(){
if(window.__lumoMicInjected)return;
window.__lumoMicInjected=true;

// Inject pulse animation CSS
var style=document.createElement('style');
style.textContent='@keyframes lumo-pulse{0%,100%{opacity:1}50%{opacity:.3}}.lumo-mic-btn.recording{color:#e5484d!important}.lumo-mic-btn.recording svg{animation:lumo-pulse 1.5s infinite}';
document.head.appendChild(style);

var SR=window.SpeechRecognition||window.webkitSpeechRecognition;
var recognition=null;
var isRecording=false;
var micBtn=null;

function getComposer(){
  return document.querySelector('textarea.tiptap, .tiptap.ProseMirror[contenteditable=true], .tiptap.ProseMirror');
}

function insertText(text){
  var ta=getComposer();
  if(!ta)return;
  if(ta.tagName==='TEXTAREA'){
    var setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;
    var cur=ta.value;
    setter.call(ta,cur+(cur&&!cur.endsWith(' ')?' ':'')+text);
    ta.dispatchEvent(new Event('input',{bubbles:true}));
  }else{
    // ProseMirror contenteditable
    ta.focus();
    document.execCommand('insertText',false,text);
  }
}

function toggleMic(){
  if(!SR){
    alert('Voice input is not supported in this browser. Please use Chrome, Edge, or Safari.');
    return;
  }
  if(isRecording){
    recognition.stop();
    return;
  }
  if(!recognition){
    recognition=new SR();
    recognition.continuous=true;
    recognition.interimResults=true;
    recognition.lang=navigator.language||'en-US';
    recognition.onresult=function(e){
      var txt='';
      for(var i=0;i<e.results.length;i++){
        txt+=e.results[i][0].transcript;
      }
      var ta=getComposer();
      if(ta&&ta.tagName==='TEXTAREA'){
        var setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;
        setter.call(ta,txt);
        ta.dispatchEvent(new Event('input',{bubbles:true}));
      }else if(ta){
        ta.textContent=txt;
        ta.dispatchEvent(new InputEvent('input',{bubbles:true}));
      }
    };
    recognition.onerror=function(){stopRecording()};
    recognition.onend=function(){stopRecording()};
  }
  try{
    recognition.start();
    isRecording=true;
    if(micBtn){
      micBtn.classList.add('recording');
      micBtn.setAttribute('aria-label','Stop voice input');
      micBtn.setAttribute('title','Stop recording');
      micBtn.querySelector('svg path').setAttribute('d','M12 2a2 2 0 0 0-2 2v8a2 2 0 0 0 4 0V4a2 2 0 0 0-2-2zM6 11a1 1 0 1 0-2 0 5 5 0 0 0 4 4.9V20H6a1 1 0 1 0 0 2h12a1 1 0 1 0 0-2h-2v-4.1A5 5 0 0 0 20 11a1 1 0 1 0-2 0 3 3 0 0 1-6 0z');
    }
  }catch(e){
    // already started
  }
}

function stopRecording(){
  isRecording=false;
  if(micBtn){
    micBtn.classList.remove('recording');
    micBtn.setAttribute('aria-label','Start voice input');
    micBtn.setAttribute('title','Voice input');
    micBtn.querySelector('svg path').setAttribute('d','M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3zM5 11a1 1 0 1 0-2 0 8 8 0 0 0 7 7.93V21H7a1 1 0 1 0 0 2h10a1 1 0 1 0 0-2h-3v-2.07A8 8 0 0 0 21 11a1 1 0 1 0-2 0 6 6 0 0 1-12 0z');
  }
}

function createMicBtn(){
  var btn=document.createElement('button');
  btn.type='button';
  btn.className='lumo-mic-btn button button-for-icon button-small button-ghost-weak border-0 shrink-0 flex flex-row flex-nowrap items-center justify-center py-1.5 rounded-full';
  btn.setAttribute('aria-label','Start voice input');
  btn.setAttribute('title','Voice input');
  btn.innerHTML='<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3zM5 11a1 1 0 1 0-2 0 8 8 0 0 0 7 7.93V21H7a1 1 0 1 0 0 2h10a1 1 0 1 0 0-2h-3v-2.07A8 8 0 0 0 21 11a1 1 0 1 0-2 0 6 6 0 0 1-12 0z"></path></svg>';
  btn.addEventListener('click',function(e){
    e.preventDefault();
    e.stopPropagation();
    toggleMic();
  });
  return btn;
}

function findToolbar(){
  // The toolbar is the div with className containing "flex flex-row flex-nowrap items-center justify-space-between w-full mt-1"
  // that's inside the composer section
  var sections=document.querySelectorAll('section[aria-label*="Ask"]');
  for(var i=0;i<sections.length;i++){
    var divs=sections[i].querySelectorAll('div');
    for(var j=0;j<divs.length;j++){
      var cls=divs[j].className||'';
      if(cls.indexOf('justify-space-between')>=0 && cls.indexOf('flex-row')>=0 && cls.indexOf('mt-1')>=0){
        // This is the toolbar — find the left-side button group
        var leftGroup=divs[j].querySelector('.flex.flex-row.flex-nowrap.items-center.gap-1.pl-2');
        if(leftGroup && !leftGroup.querySelector('.lumo-mic-btn')){
          return leftGroup;
        }
      }
    }
  }
  return null;
}

function injectMic(){
  var toolbar=findToolbar();
  if(!toolbar)return false;
  micBtn=createMicBtn();
  // Insert after the first button (the attachment + button)
  if(toolbar.children.length>0){
    toolbar.insertBefore(micBtn,toolbar.children[1]||null);
  }else{
    toolbar.appendChild(micBtn);
  }
  return true;
}

// Watch for the composer to appear and inject the mic button
var observer=new MutationObserver(function(){
  if(!micBtn||!document.body.contains(micBtn)){
    injectMic();
  }
});
observer.observe(document.body,{childList:true,subtree:true});

// Also try immediately
setTimeout(injectMic,1000);
setTimeout(injectMic,3000);
})();`;

const scriptPath = `${STATIC}/lumo-mic-inject.js`;
fs.writeFileSync(scriptPath, MIC_SCRIPT);
console.log(`Wrote ${scriptPath} (${MIC_SCRIPT.length} bytes)`);

// ── 2. Add the script tag to index.html ─────────────────────────────────────
const indexPath = `${DIST}/index.html`;
let index = fs.readFileSync(indexPath, 'utf8');

// Add the script tag before </body> (or at the end of <head>)
const scriptTag = `<script src="/assets/static/lumo-mic-inject.js?v=${VERSION}" defer></script>`;
if (!index.includes('lumo-mic-inject.js')) {
    // Insert before the closing </head> or at the end of the file
    if (index.includes('</head>')) {
        index = index.replace('</head>', scriptTag + '</head>');
    } else {
        // Append at the end
        index = index + scriptTag;
    }
    console.log('Added mic script tag to index.html');
} else {
    console.log('Mic script tag already in index.html');
}

fs.writeFileSync(indexPath, index);

// ── 3. Bump the boot runtime version ────────────────────────────────────────
const runtimeFiles = fs.readdirSync(STATIC).filter(f => /^runtime\.[a-f0-9]+\.js$/.test(f));
let index2 = fs.readFileSync(indexPath, 'utf8');
const rtTagRe = /src="\/assets\/static\/(runtime\.[a-f0-9]+)\.js(\?v=\d+)?" integrity="sha384-[^"]+"/;
const m = index2.match(rtTagRe);
if (m) {
    const runtimeHash = sri(fs.readFileSync(`${STATIC}/${m[1]}.js`));
    index2 = index2.replace(rtTagRe, `src="/assets/static/${m[1]}.js?${VERSION}" integrity="${runtimeHash}"`);
    fs.writeFileSync(indexPath, index2);
    console.log(`Bumped ${m[1]}.js -> ?${VERSION}`);
}

// Verify SRI
let mm = 0, ck = 0;
for (const rf of runtimeFiles) {
    const rt = fs.readFileSync(`${STATIC}/${rf}`, 'utf8');
    const re = /(\d{3,4})===s\?"assets\/static\/([^"?]+)\.chunk\.js(?:\?v=\d+)?"/g;
    let mt;
    while ((mt = re.exec(rt)) !== null) {
        const pp = mt[1], cb = mt[2];
        const ir = new RegExp(pp + ':"sha384-([A-Za-z0-9+/=]+)"');
        const i = rt.match(ir);
        if (!i) continue;
        const f = fs.readdirSync(STATIC).filter(x => x === cb + '.chunk.js');
        if (!f.length) continue;
        const a = sri(fs.readFileSync(`${STATIC}/${f[0]}`));
        ck++;
        if (i[1] !== a.slice(7)) mm++;
    }
}
console.log(`integrity check: ${ck} checked, ${mm} mismatches`);

// Check 4206 syntax
const chunk4206 = fs.readFileSync(`${STATIC}/4206.9903be83.chunk.js`, 'utf8');
try { new Function(chunk4206); console.log('4206 syntax: OK'); }
catch (e) { console.log('4206 SYNTAX ERROR:', e.message.slice(0, 80)); }
