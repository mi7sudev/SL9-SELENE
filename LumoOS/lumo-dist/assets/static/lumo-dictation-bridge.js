// Bridge the SPA's built-in dictation mic button to the Web Speech API.
//
// Architecture (matching the native Android app's JsInjector approach):
// 1. The SPA already has a mic button (#voice-entry-mobile-button) that's
//    shown when the LumoDictationV2 feature flag is enabled.
// 2. The SPA's built-in useDictation hook tries to connect to a WebSocket
//    at wss://${host}/api/ai/v1/realtime — which doesn't exist on our
//    self-hosted server.
// 3. This script intercepts the mic button click, prevents the WebSocket
//    connection, and uses the Web Speech API (SpeechRecognition) instead.
// 4. Recognized text is inserted into the composer using the same mechanism
//    the SPA uses (finding the .tiptap.ProseMirror.composer element).
//
// This is exactly what the native Android app does: it hooks the button to
// window.Android.startVoiceEntry() and uses native speech recognition.
// We do the same but with the browser's Web Speech API.
(function(){
if(window.__lumoDictationBridge)return;
window.__lumoDictationBridge=true;

// Inject pulse animation + dictation UI CSS
var style=document.createElement('style');
style.textContent='@keyframes lumo-mic-pulse{0%,100%{opacity:1}50%{opacity:.3}}#voice-entry-mobile-button.lumo-recording{color:#e5484d!important}#voice-entry-mobile-button.lumo-recording svg{animation:lumo-mic-pulse 1.5s infinite}';
document.head.appendChild(style);

var SR=window.SpeechRecognition||window.webkitSpeechRecognition;
var recognition=null;
var isRecording=false;
var micBtn=null;
var originalOnClick=null;

function getComposer(){
  return document.querySelector('textarea.tiptap, .tiptap.ProseMirror[contenteditable=true], .tiptap.ProseMirror');
}

function insertText(text){
  var ta=getComposer();
  if(!ta)return;
  if(ta.tagName==='TEXTAREA'){
    var setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;
    setter.call(ta,text);
    ta.dispatchEvent(new Event('input',{bubbles:true}));
  }else{
    // ProseMirror contenteditable — append to the last paragraph
    ta.focus();
    var lastP=ta.querySelector('p:last-child');
    if(lastP){
      lastP.textContent=text;
    }else{
      document.execCommand('insertText',false,text);
    }
    ta.dispatchEvent(new InputEvent('input',{bubbles:true}));
  }
}

function startRecording(){
  if(!SR){
    alert('Voice input is not supported in this browser. Please use Chrome, Edge, or Safari.');
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
      insertText(txt);
    };
    recognition.onerror=function(){stopRecording()};
    recognition.onend=function(){stopRecording()};
  }
  try{
    recognition.start();
    isRecording=true;
    if(micBtn){
      micBtn.classList.add('lumo-recording');
      micBtn.setAttribute('aria-label','Stop dictation');
      micBtn.setAttribute('title','Stop dictation');
    }
  }catch(e){}
}

function stopRecording(){
  if(recognition){
    try{recognition.stop()}catch(e){}
  }
  isRecording=false;
  if(micBtn){
    micBtn.classList.remove('lumo-recording');
    micBtn.setAttribute('aria-label','Dictate');
    micBtn.setAttribute('title','Dictate');
  }
}

function toggleDictation(e){
  // Prevent the SPA's built-in WebSocket dictation from starting
  if(e){e.preventDefault();e.stopPropagation();}
  if(isRecording){
    stopRecording();
  }else{
    startRecording();
  }
  return false;
}

function hookMicButton(){
  var btn=document.getElementById('voice-entry-mobile-button');
  if(!btn||btn===micBtn)return false;
  micBtn=btn;
  // Replace the click handler with our Web Speech API bridge
  btn.addEventListener('click',toggleDictation,true);
  // Also unhide the container (the SPA hides it when the flag is off,
  // but we enabled the flag, so it should be visible)
  var container=document.getElementById('voice-entry-mobile');
  if(container){
    container.classList.remove('hidden');
    container.style.display='';
  }
  return true;
}

// Watch for the mic button to appear (it's rendered by React after the
// composer mounts)
var observer=new MutationObserver(function(){
  if(!micBtn||!document.body.contains(micBtn)){
    hookMicButton();
  }
});
observer.observe(document.body,{childList:true,subtree:true});

// Also try periodically



})();
