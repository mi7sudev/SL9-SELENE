// V2 admin UI: split into 3 separate settings tabs + add Test Connection +
// per-model edit/delete on the AI Provider tab.
//
// Changes vs the original patch-admin-ui.cjs injection:
//   1. ZAdminPanel (one panel with providers+users+mcp) is replaced by THREE
//      separate components: ZProvPanel, ZUsersPanel, ZMcpPanel.
//   2. Three admin-role wrappers (la2/la3/la4 for 1306, nG2/nG3/nG4 for 4124)
//      are registered — one per settings tab.
//   3. The settings nav array (l_ / lo) gets two new entries: "users" and
//      "mcp-servers", inserted right after "ai-provider".
//   4. The settings switch gets two new cases routing to the new wrappers.
//   5. ZProvPanel adds:
//        - "Test connection" button per provider (calls /admin/models, shows
//          ✓ OK + model count or ✗ error)
//        - Per-model Edit (pencil → inline rename) and Delete (trash) buttons
//          on every model row
//
// This script REMOVES the old injected block (var ZADMIN_CSS=…;let ZAdminPanel=…;
// let <wrapper>=…;) and replaces it with the new code, so it is idempotent.
const fs = require('fs');
const crypto = require('crypto');

const DIST = process.env.LUMO_DIST_DIR || '/home/z/my-project/LumoOS/lumo-dist';
const STATIC = `${DIST}/assets/static`;
const VERSION = 'v=59';
const sri = (buf) => 'sha384-' + crypto.createHash('sha384').update(buf).digest('base64');

// ── shared CSS — matched to the native Lumo settings design system ───────────
// The native tabs (Account, General, Appearance) use:
//   - container: "flex flex-column flex-nowrap *:min-size-auto gap-4"
//   - n8 SectionHeader rows (icon + title + subtitle + control), stacked
//   - NO bordered cards — content sits directly in the flex column
//   - native nw.Ay inputs and k.$ buttons
// This stylesheet keeps only the styles the native kit has no equivalent for
// (model rows, chips, dropdown menus, test pills) and renders them as flat,
// borderless rows consistent with the native n8 row look.
const ZADMIN_CSS = ".zap-mlist{display:flex;flex-direction:column;gap:6px}" +
".zap-mitem{display:flex;flex-direction:column;gap:4px}" +
".zap-mrow{display:flex;align-items:center;gap:8px;padding:8px 12px;border:1px solid var(--border-weak);border-radius:8px;background:var(--background-norm);min-width:0}" +
".zap-mrow-id{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text-norm,#fafafa)}" +
".zap-mrow-edit{flex:1 1 auto;min-width:0}" +
".zap-ibtn{flex-shrink:0;width:28px;height:28px;display:inline-flex;align-items:center;justify-content:center;border:0;border-radius:6px;background:transparent;color:var(--text-weak);cursor:pointer;padding:0;transition:color .15s,background .15s}" +
".zap-ibtn:hover{color:var(--primary,#6d4aff);background:var(--background-weak)}" +
".zap-ibtn-dng:hover{color:#e5484d}" +
".zap-ibtn:disabled{opacity:.5;cursor:default}" +
".zap-test{display:inline-flex;align-items:center;gap:4px;align-self:flex-start;padding:2px 8px;border-radius:999px;font-size:.8em;line-height:1.5;margin-left:2px}" +
".zap-test-ok{color:#3dd68c}" +
".zap-test-fail{color:#e5484d;max-width:100%}" +
".zap-test-fail span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
".zap-chip{position:relative;display:flex;align-items:center;padding:6px 10px 6px 28px;border-radius:8px;background:var(--background-weak);cursor:pointer;font-size:.9em;line-height:1.35;min-width:0}" +
".zap-chip::before{content:\"\";position:absolute;left:8px;top:50%;transform:translateY(-50%);width:14px;height:14px;border:1.5px solid var(--border-weak);border-radius:4px;background:var(--background-norm)}" +
".zap-chip::after{content:\"\";position:absolute;left:13px;top:calc(50% - 4px);width:4px;height:8px;border-right:1.5px solid #fff;border-bottom:1.5px solid #fff;transform:rotate(45deg);opacity:0}" +
".zap-chip input{position:absolute;left:8px;top:50%;transform:translateY(-50%);width:14px;height:14px;margin:0;opacity:0}" +
".zap-chip:focus-within::before{border-color:var(--primary,#6d4aff)}" +
".zap-chip span{overflow-wrap:anywhere}" +
".zap-chip-on{background:var(--primary-minor-1,rgba(109,74,255,.12))}" +
".zap-chip-on::before{background:var(--primary,#6d4aff);border-color:var(--primary,#6d4aff)}" +
".zap-chip-on::after{opacity:1}" +
".zap-user{display:flex;align-items:center;gap:10px;padding:8px 4px;min-width:0}" +
".zap-userinfo{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1 1 auto}" +
".zap-userinfo span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
".zap-dd{position:relative}" +
".zap-dd-btn{display:flex;align-items:center;gap:6px;min-width:180px;max-width:300px;padding:6px 10px;border:1px solid var(--border-weak);border-radius:8px;background:var(--background-norm);color:var(--text-norm,#fafafa);font:inherit;font-size:.9em;cursor:pointer;text-align:left}" +
".zap-dd-caret{margin-left:auto;opacity:.6;flex-shrink:0;font-size:.8em}" +
".zap-dd-txt{display:flex;flex-direction:column;gap:1px;min-width:0}" +
".zap-dd-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
".zap-dd-url{font-size:.85em;opacity:.65;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
".zap-dd-overlay{position:fixed;inset:0;z-index:998}" +
".zap-dd-menu{position:absolute;top:calc(100% + 6px);left:0;min-width:240px;max-width:340px;max-height:280px;overflow:auto;z-index:999;padding:4px;background:var(--background-norm);border:1px solid var(--border-weak);border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.45)}" +
".zap-dd-item{display:flex;align-items:center;gap:8px;width:100%;padding:8px 10px;border:0;border-radius:8px;background:transparent;color:var(--text-norm,#fafafa);font:inherit;font-size:.9em;cursor:pointer;text-align:left}" +
".zap-dd-item-on{background:var(--primary-minor-1,rgba(109,74,255,.12))}" +
".zap-dd-check{margin-left:auto;color:var(--primary,#6d4aff);flex-shrink:0}" +
".zap-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}" +
".zap-dot-connected{background:#3dd68c}" +
".zap-dot-error{background:#e5484d}" +
".zap-dot-disconnected{background:var(--border-weak)}" +
".zap-empty{color:var(--text-weak);font-size:.9em;padding:4px 0}";

// ── ZProvPanel: AI providers only + Test Connection + per-model edit/del ─────
// State: provs (provider list), sel (selected index), msg (status message),
//        addModel (manual add input), saving (save in progress),
//        ddOpen (dropdown open id), editIdx (index of model being edited),
//        editVal (edit input value), testing (test in progress)
const ZPROV_PANEL = `let ZProvPanel=()=>{let _ps=(0,n.useState)(null),provs=_ps[0],setPs=_ps[1],_si=(0,n.useState)(0),sel=_si[0],setSel=_si[1],_m=(0,n.useState)(""),msg=_m[0],setMsg=_m[1],_sv=(0,n.useState)(!1),saving=_sv[0],setSaving=_sv[1],_pd=(0,n.useState)(null),ddOpen=_pd[0],setDdOpen=_pd[1],_tm=(0,n.useState)(""),testingModel=_tm[0],setTestingModel=_tm[1],_tr=(0,n.useState)({}),testRes=_tr[0],setTestRes=_tr[1],_mm=(0,n.useState)(null),modelModal=_mm[0],setModelModal=_mm[1];
var load=(0,n.useCallback)(function(){fetch("/api/lumo/v1/admin/config").then(function(r){return r.ok?r.json():null}).then(function(j){if(j&&j.Config){var ps=(j.Config.providers||[]).map(function(p){return{id:p.id||"",name:p.name||"",baseUrl:p.baseUrl||"",hasApiKey:!!p.hasApiKey,models:(p.models||[]).slice(),modelMeta:p.modelMeta||{},avail:[],key:""}});setPs(ps.length?ps:[{id:"p1",name:"",baseUrl:"",hasApiKey:!1,models:[],modelMeta:{},avail:[],key:""}]),setSel(0)}}).catch(function(){})},[]);
(0,n.useEffect)(function(){load()},[load]);
if(!provs)return(0,a.jsxs)("div",{className:"flex flex-column flex-nowrap *:min-size-auto gap-4",children:[(0,a.jsx)("style",{children:ZADMIN_CSS}),(0,a.jsx)(%SEC%,{icon:"Cpu",text:"AI providers",subtext:"Loading…"}),(0,a.jsx)("div",{className:"flex flex-row flex-nowrap gap-2",children:(0,a.jsx)(%SPIN%.m,{size:"small"})})]});
var jsonReq=function(r){return r.json().then(function(j){return{ok:r.ok,j:j}})},idx=Math.min(sel,provs.length-1),cur=provs[idx],upd=function(k2,v){setPs(provs.map(function(p,i){var q=Object.assign({},p);return i===idx&&(q[k2]=v),q}))};
var getMeta=function(mid){var mm=cur.modelMeta||{};return mm[mid]||{contextWindow:"",maxOutput:"",inputTypes:["text"],outputTypes:["text"]}};
var openAddModel=function(){setModelModal({editing:!1,origId:"",id:"",contextWindow:"",maxOutput:"",inputTypes:["text"],outputTypes:["text"]})};
var openEditModel=function(mi){var mid=cur.models[mi];var m=getMeta(mid);setModelModal({editing:!0,origId:mid,id:mid,contextWindow:m.contextWindow||"",maxOutput:m.maxOutput||"",inputTypes:(m.inputTypes||["text"]).slice(),outputTypes:(m.outputTypes||["text"]).slice()})};
var closeModelModal=function(){setModelModal(null)};
var saveModelModal=function(){var f=modelModal;if(!f)return;var v=f.id.trim();if(!v)return;var meta={contextWindow:Number(f.contextWindow)>0?Number(f.contextWindow):null,maxOutput:Number(f.maxOutput)>0?Number(f.maxOutput):null,inputTypes:f.inputTypes.slice(),outputTypes:f.outputTypes.slice()};setPs(provs.map(function(p,i){if(i!==idx)return p;var ms=p.models.slice();var mm=Object.assign({},p.modelMeta||{});if(f.editing){var mi=ms.indexOf(f.origId);if(mi>=0)ms[mi]=v;delete mm[f.origId];mm[v]=meta}else{if(ms.indexOf(v)===-1)ms.push(v);mm[v]=meta}return Object.assign({},p,{models:ms,modelMeta:mm})})),setModelModal(null)};
var delModel=function(mIdx){if(!window.confirm("Remove this model from the allowed list?"))return;setPs(provs.map(function(p,i){if(i!==idx)return p;var mid=p.models[mIdx];var mm=Object.assign({},p.modelMeta||{});delete mm[mid];return Object.assign({},p,{models:p.models.filter(function(x,j){return j!==mIdx}),modelMeta:mm})}))};
var addProvider=function(){setPs(provs.concat([{id:"p"+Date.now().toString(36),name:"",baseUrl:"",hasApiKey:!1,models:[],modelMeta:{},avail:[],key:""}])),setSel(provs.length)};
var delProvider=function(){window.confirm("Delete this provider and its model list?")&&(setPs(provs.filter(function(p,i){return i!==idx})),setSel(0))};
var browse=function(){var t2=(cur.baseUrl||"").replace(/\\/+$/,"");if(!t2){setMsg("Enter the provider base URL first");return}setMsg("Fetching model list…"),fetch("/api/lumo/v1/admin/models",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({providerId:cur.id||void 0,baseUrl:t2,apiKey:cur.key||void 0})}).then(jsonReq).then(function(x){if(!x.ok){setMsg(x.j&&x.j.Error?x.j.Error:"Failed to fetch models");return}var ids=((x.j&&x.j.data)||[]).map(function(y){return y&&y.id}).filter(function(y){return typeof y==="string"&&y});setPs(provs.map(function(p,i){if(i!==idx)return p;var av=p.avail.slice();ids.forEach(function(id){if(av.indexOf(id)===-1)av.push(id)});var ms=p.models.slice();ids.forEach(function(id){if(ms.indexOf(id)===-1)ms.push(id)});return Object.assign({},p,{avail:av,models:ms})})),setMsg("Found "+ids.length+" models — added to the list.")}).catch(function(){setMsg("Failed to fetch models")})};
var testModel=function(mi){var mid=cur.models[mi];if(!mid)return;var t2=(cur.baseUrl||"").replace(/\\/+$/,"");if(!t2){setMsg("Enter the provider base URL first");return}setTestingModel(mid);setTestRes(function(pr){var c=Object.assign({},pr);c[mid]={testing:!0};return c});fetch("/api/lumo/v1/admin/test-model",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({providerId:cur.id||void 0,baseUrl:t2,apiKey:cur.key||void 0,model:mid})}).then(jsonReq).then(function(x){setTestingModel("");if(x.ok&&x.j&&x.j.ok){setTestRes(function(pr){var c=Object.assign({},pr);c[mid]={ok:!0,msg:"Connected!"};return c})}else{var er=x.j&&x.j.error?x.j.error:x.j&&x.j.Error?x.j.Error:"unknown error";setTestRes(function(pr){var c=Object.assign({},pr);c[mid]={ok:!1,msg:"Connection failed: "+er};return c})}}).catch(function(){setTestingModel("");setTestRes(function(pr){var c=Object.assign({},pr);c[mid]={ok:!1,msg:"Connection failed: network error"};return c})})};
var saveAll=function(){setSaving(!0),fetch("/api/lumo/v1/admin/config",{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({providers:provs.map(function(p){var o={id:p.id,name:p.name||"",baseUrl:(p.baseUrl||"").trim(),models:p.models,modelMeta:p.modelMeta||{}};return p.key&&(o.apiKey=p.key),o})})}).then(jsonReq).then(function(x){x.ok?(setMsg("OK:Saved — users now see these providers and models."),setPs(provs.map(function(p){return Object.assign({},p,{key:"",hasApiKey:p.hasApiKey||!!p.key})}))):setMsg(x.j&&x.j.Error?("FAIL:"+(x.j.Error)):"FAIL:Failed to save")}).catch(function(){setMsg("FAIL:Failed to save")}).finally(function(){return setSaving(!1)})};
var dd=function(id,small,label,items,onPick){return(0,a.jsxs)("div",{className:"zap-dd"+(small?" zap-dd-sm":""),children:[(0,a.jsxs)("button",{type:"button",className:"zap-dd-btn",onClick:function(){return setDdOpen(ddOpen===id?null:id)},children:[(0,a.jsx)("span",{className:"zap-dd-txt",children:(0,a.jsx)("span",{className:"zap-dd-name",children:label})}),(0,a.jsx)("span",{className:"zap-dd-caret",children:"▼"})]}),ddOpen===id?(0,a.jsx)("div",{className:"zap-dd-overlay",onClick:function(){return setDdOpen(null)}}):null,ddOpen===id?(0,a.jsx)("div",{className:"zap-dd-menu",children:items.map(function(it,i){return(0,a.jsxs)("button",{type:"button",className:"zap-dd-item"+(it.on?" zap-dd-item-on":""),onClick:function(){onPick(it.v),setDdOpen(null)},children:[(0,a.jsxs)("span",{className:"zap-dd-txt",children:[(0,a.jsx)("span",{className:"zap-dd-name",children:it.label}),it.sub?(0,a.jsx)("span",{className:"zap-dd-url",children:it.sub}):null]}),it.on?(0,a.jsx)("span",{className:"zap-dd-check",children:"✓"}):null]},it.v+"-"+i)})}):null]})};
var modalEl=modelModal?(0,a.jsxs)("div",{style:{position:"fixed",inset:0,background:"rgba(0,0,0,.5)",zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center",padding:16},onClick:closeModelModal,children:[(0,a.jsxs)("div",{onClick:function(e){e.stopPropagation()},style:{background:"var(--background-norm,#fff)",borderRadius:12,padding:24,maxWidth:480,width:"100%",maxHeight:"90vh",overflowY:"auto",boxShadow:"0 20px 60px rgba(0,0,0,.3)"},children:[(0,a.jsxs)("div",{className:"flex flex-row flex-nowrap items-center justify-space-between mb-4",children:[(0,a.jsx)("span",{className:"text-bold text-lg",children:modelModal.editing?"Edit model settings":"Add model"}),(0,a.jsx)("button",{type:"button",onClick:closeModelModal,style:{border:0,background:"transparent",cursor:"pointer",color:"var(--text-weak)",fontSize:20},children:(0,a.jsx)(%ICON%.z,{name:"X",size:20})})]}),(0,a.jsx)(%INPUT%.Ay,{id:"zap-mm-id",label:"Model ID",placeholder:"provider/model-name",value:modelModal.id,assistContainerClassName:"hidden",onChange:function(e){return setModelModal(Object.assign({},modelModal,{id:e.target.value}))}}),(0,a.jsx)(%INPUT%.Ay,{id:"zap-mm-ctx",label:"Context window (tokens)",placeholder:"e.g. 128000",type:"number",value:modelModal.contextWindow,assistContainerClassName:"hidden",onChange:function(e){return setModelModal(Object.assign({},modelModal,{contextWindow:e.target.value}))}}),(0,a.jsx)(%INPUT%.Ay,{id:"zap-mm-max",label:"Max output tokens",placeholder:"e.g. 4096",type:"number",value:modelModal.maxOutput,assistContainerClassName:"hidden",onChange:function(e){return setModelModal(Object.assign({},modelModal,{maxOutput:e.target.value}))}}),(0,a.jsxs)("div",{className:"flex flex-column gap-2 mt-4",children:[(0,a.jsx)("span",{className:"text-semibold text-sm",children:"Input types"}),(0,a.jsxs)("div",{className:"flex flex-row flex-wrap gap-2",children:["text","image","video","pdf"].map(function(t){var on=modelModal.inputTypes.indexOf(t)!==-1;return(0,a.jsxs)("label",{className:"zap-chip"+(on?" zap-chip-on":""),style:{cursor:t==="text"?"default":"pointer",opacity:t==="text"?0.7:1},children:[(0,a.jsx)("input",{type:"checkbox",checked:on,disabled:t==="text",onChange:function(){setModelModal(Object.assign({},modelModal,{inputTypes:on?modelModal.inputTypes.filter(function(x){return x!==t}):modelModal.inputTypes.concat([t])}))}}),(0,a.jsx)("span",{children:t+(t==="text"?" (locked)":"")})]},t)})})]}),(0,a.jsxs)("div",{className:"flex flex-column gap-2 mt-4",children:[(0,a.jsx)("span",{className:"text-semibold text-sm",children:"Output types"}),(0,a.jsxs)("div",{className:"flex flex-row flex-wrap gap-2",children:["text"].map(function(t){return(0,a.jsxs)("label",{className:"zap-chip zap-chip-on",style:{cursor:"default",opacity:0.7},children:[(0,a.jsx)("input",{type:"checkbox",checked:!0,disabled:!0}),(0,a.jsx)("span",{children:t+" (locked)"})]},t)})})]}),(0,a.jsxs)("div",{className:"flex flex-row flex-nowrap items-center justify-end gap-2 mt-6",children:[(0,a.jsx)(%BTN%.$,{shape:"ghost",size:"small",onClick:closeModelModal,children:"Cancel"}),(0,a.jsx)(%BTN%.$,{color:"norm",size:"small",disabled:!modelModal.id.trim(),onClick:saveModelModal,children:"Save"})]})]})]}):null;
var msgEl=msg?(0,a.jsx)("span",{className:msg.indexOf("OK:")===0?"color-success text-sm":msg.indexOf("FAIL:")===0?"color-danger text-sm":"color-weak text-sm",children:msg.replace(/^(OK:|FAIL:)/,"")}):null;
return(0,a.jsxs)("div",{className:"flex flex-column flex-nowrap *:min-size-auto gap-4",children:[(0,a.jsx)("style",{children:ZADMIN_CSS}),(0,a.jsx)(%SEC%,{icon:"Cpu",text:"AI providers",subtext:"Configure the BYOK providers and the models users can pick from.",button:(0,a.jsxs)("div",{className:"flex flex-row flex-nowrap gap-2",children:[(0,a.jsx)(%BTN%.$,{shape:"outline",size:"small",onClick:addProvider,children:"+ Add provider"}),(0,a.jsx)(%BTN%.$,{shape:"outline",color:"danger",size:"small",onClick:delProvider,children:"Delete"})]})}),(0,a.jsx)("div",{className:"flex flex-row flex-nowrap items-end gap-2 w-full",children:[(0,a.jsx)("div",{className:"flex-1 min-w-0",children:dd("prov",!1,cur.name||cur.baseUrl||"Provider "+(idx+1),provs.map(function(p,i){return{v:i,label:p.name||p.baseUrl||"Provider "+(i+1),sub:p.name?p.baseUrl||"(no base URL)":null,on:i===idx}}),function(v){return setSel(v)})})]}),msgEl,(0,a.jsx)(%INPUT%.Ay,{id:"zap-p-name",label:"Provider name (optional)",placeholder:"Optional display name",value:cur.name,assistContainerClassName:"hidden",onChange:function(e){return upd("name",e.target.value)}}),(0,a.jsx)(%INPUT%.Ay,{id:"zap-p-url",label:"Provider base URL",placeholder:"https://api.example.com/v1",value:cur.baseUrl,assistContainerClassName:"hidden",onChange:function(e){return upd("baseUrl",e.target.value)}}),(0,a.jsx)(%INPUT%.Ay,{id:"zap-p-key",label:"Provider API key",type:"password",placeholder:cur.hasApiKey?"Saved — leave blank to keep":"Paste the provider's API key",value:cur.key,assistContainerClassName:"hidden",onChange:function(e){return upd("key",e.target.value)}}),(0,a.jsxs)("div",{className:"flex flex-row flex-nowrap items-end gap-2 w-full",children:[(0,a.jsx)("div",{className:"flex-1"}),(0,a.jsx)(%BTN%.$,{shape:"outline",size:"small",disabled:!cur.baseUrl.trim(),onClick:browse,children:"Fetch model list"})]}),(0,a.jsxs)("div",{className:"flex flex-column gap-2",children:[(0,a.jsxs)("div",{className:"flex flex-row flex-nowrap items-baseline justify-space-between gap-2",children:[(0,a.jsx)("span",{className:"text-semibold text-sm",children:"Models"}),(0,a.jsxs)("div",{className:"flex flex-row flex-nowrap gap-2",children:[(0,a.jsx)("span",{className:"color-weak text-sm",children:cur.models.length+" total"}),(0,a.jsx)(%BTN%.$,{shape:"outline",size:"small",onClick:openAddModel,children:"+ Add model"})]})]}),cur.models.length===0?(0,a.jsx)("span",{className:"color-weak text-sm",children:"No models yet — use Fetch model list or Add model."}):(0,a.jsx)("div",{className:"zap-mlist",children:cur.models.map(function(id,mi){var tr=testRes[id];var meta=getMeta(id);var ctxLbl=meta.contextWindow?meta.contextWindow>=1000?Math.round(meta.contextWindow/1000)+"K":String(meta.contextWindow):"";return(0,a.jsxs)("div",{className:"zap-mitem",children:[(0,a.jsxs)("div",{className:"zap-mrow",children:[(0,a.jsx)("span",{className:"zap-mrow-id",title:id,children:id}),ctxLbl?(0,a.jsx)("span",{style:{flexShrink:0,fontSize:".75em",padding:"2px 6px",borderRadius:4,background:"var(--background-weak)",color:"var(--text-weak)"},children:ctxLbl}):null,(0,a.jsx)("button",{type:"button",className:"zap-ibtn",onClick:function(){return testModel(mi)},title:"Test connection",disabled:testingModel===id,children:(0,a.jsx)(%ICON%.z,{name:testingModel===id?"Hourglass":"Zap",size:16})}),(0,a.jsx)("button",{type:"button",className:"zap-ibtn",onClick:function(){return openEditModel(mi)},title:"Edit",children:(0,a.jsx)(%ICON%.z,{name:"Pencil",size:16})}),(0,a.jsx)("button",{type:"button",className:"zap-ibtn zap-ibtn-dng",onClick:function(){return delModel(mi)},title:"Delete",children:(0,a.jsx)(%ICON%.z,{name:"Trash2",size:16})})]},id),tr&&!tr.testing?(tr.ok?(0,a.jsx)("span",{className:"zap-test zap-test-ok",children:[(0,a.jsx)(%ICON%.z,{name:"Check",size:12}),tr.msg]}):(0,a.jsx)("span",{className:"zap-test zap-test-fail",title:tr.msg,children:[(0,a.jsx)(%ICON%.z,{name:"X",size:12}),tr.msg]})):null]},id)})})]}),modalEl,(0,a.jsxs)("div",{className:"flex flex-row flex-nowrap items-center gap-2",children:[(0,a.jsx)("span",{className:"color-weak text-sm flex-1",children:"Changes apply to everyone on this instance."}),(0,a.jsx)(%BTN%.$,{color:"norm",size:"small",loading:saving,onClick:saveAll,children:"Save providers"})]})]})};`;

// ── ZUsersPanel: user management only ────────────────────────────────────────
const ZUSERS_PANEL = `let ZUsersPanel=()=>{let _u=(0,n.useState)(null),users=_u[0],setU=_u[1],_sf=(0,n.useState)(null),selfId=_sf[0],setSelfId=_sf[1],_m=(0,n.useState)(""),msg=_m[0],setMsg=_m[1],_pd=(0,n.useState)(null),ddOpen=_pd[0],setDdOpen=_pd[1];
var loadUsers=(0,n.useCallback)(function(){fetch("/api/lumo/v1/admin/users").then(function(r){return r.ok?r.json():null}).then(function(j){setU(j?j.Users:null)}).catch(function(){})},[]);
(0,n.useEffect)(function(){loadUsers(),fetch("/api/core/v4/users").then(function(r){return r.ok?r.json():null}).then(function(j){j&&j.User&&j.User.ID&&setSelfId(j.User.ID)}).catch(function(){})},[loadUsers]);
if(!users)return(0,a.jsxs)("div",{className:"flex flex-column flex-nowrap *:min-size-auto gap-4",children:[(0,a.jsx)("style",{children:ZADMIN_CSS}),(0,a.jsx)(%SEC%,{icon:"User",text:"Users",subtext:"Manage accounts, roles, and access for this instance."}),(0,a.jsx)("div",{className:"flex flex-row flex-nowrap gap-2",children:(0,a.jsx)(%SPIN%.m,{size:"small"})})]});
var jsonReq=function(r){return r.json().then(function(j){return{ok:r.ok,j:j}})};
var pu=function(uid,patch){fetch("/api/lumo/v1/admin/users",{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify(Object.assign({uid:uid},patch))}).then(jsonReq).then(function(x){setMsg(x.ok?"OK:Saved":("FAIL:"+(x.j&&x.j.Error?x.j.Error:"Failed"))),loadUsers()}).catch(function(){setMsg("FAIL:Failed")})};
var du=function(uid){window.confirm("Delete this user and all their data?")&&fetch("/api/lumo/v1/admin/users",{method:"DELETE",headers:{"Content-Type":"application/json"},body:JSON.stringify({uid:uid})}).then(jsonReq).then(function(x){setMsg(x.ok?"OK:User deleted":("FAIL:"+(x.j&&x.j.Error?x.j.Error:"Failed"))),loadUsers()}).catch(function(){setMsg("FAIL:Failed")})};
var dd=function(id,small,label,items,onPick){return(0,a.jsxs)("div",{className:"zap-dd"+(small?" zap-dd-sm":""),children:[(0,a.jsxs)("button",{type:"button",className:"zap-dd-btn",onClick:function(){return setDdOpen(ddOpen===id?null:id)},children:[(0,a.jsx)("span",{className:"zap-dd-txt",children:(0,a.jsx)("span",{className:"zap-dd-name",children:label})}),(0,a.jsx)("span",{className:"zap-dd-caret",children:"▼"})]}),ddOpen===id?(0,a.jsx)("div",{className:"zap-dd-overlay",onClick:function(){return setDdOpen(null)}}):null,ddOpen===id?(0,a.jsx)("div",{className:"zap-dd-menu",children:items.map(function(it,i){return(0,a.jsxs)("button",{type:"button",className:"zap-dd-item"+(it.on?" zap-dd-item-on":""),onClick:function(){onPick(it.v),setDdOpen(null)},children:[(0,a.jsxs)("span",{className:"zap-dd-txt",children:[(0,a.jsx)("span",{className:"zap-dd-name",children:it.label}),it.sub?(0,a.jsx)("span",{className:"zap-dd-url",children:it.sub}):null]}),it.on?(0,a.jsx)("span",{className:"zap-dd-check",children:"✓"}):null]},it.v+"-"+i)})}):null]})};
var msgEl=msg?(0,a.jsx)("span",{className:msg.indexOf("OK:")===0?"color-success text-sm":msg.indexOf("FAIL:")===0?"color-danger text-sm":"color-weak text-sm",children:msg.replace(/^(OK:|FAIL:)/,"")}):null;
return(0,a.jsxs)("div",{className:"flex flex-column flex-nowrap *:min-size-auto gap-4",children:[(0,a.jsx)("style",{children:ZADMIN_CSS}),(0,a.jsx)(%SEC%,{icon:"User",text:"Users",subtext:"Manage accounts, roles, and access for this instance."}),msgEl,users.length===0?(0,a.jsx)("span",{className:"zap-empty",children:"No users found."}):users.map(function(u2){return(0,a.jsx)(%SEC%,{icon:"User",text:u2.displayName||u2.username,subtext:u2.username+(u2.role==="admin"?" · admin":"")+(u2.disabled?" · disabled":""),button:u2.uid===selfId?(0,a.jsx)("span",{className:"color-weak text-sm",children:"You"}):(0,a.jsxs)("div",{className:"flex flex-row flex-nowrap gap-2",children:[dd("u"+u2.uid,!0,u2.role,[{v:"user",label:"user",on:u2.role==="user"},{v:"admin",label:"admin",on:u2.role==="admin"}],function(v){return pu(u2.uid,{role:v})}),(0,a.jsx)(%BTN%.$,{shape:"ghost",size:"small",onClick:function(){return pu(u2.uid,{disabled:!u2.disabled})},children:u2.disabled?"Enable":"Disable"}),(0,a.jsx)(%BTN%.$,{shape:"outline",color:"danger",size:"small",onClick:function(){return du(u2.uid)},children:"Delete"})]})},u2.uid)})]})};`;

// ── ZMcpPanel: MCP servers only ──────────────────────────────────────────────
const ZMCP_PANEL = `let ZMcpPanel=()=>{let _ms=(0,n.useState)(null),mcp=_ms[0],setMcp=_ms[1],_mf=(0,n.useState)(null),mcpForm=_mf[0],setMcpForm=_mf[1],_mb=(0,n.useState)(!1),mcpBusy=_mb[0],setMcpBusy=_mb[1],_m=(0,n.useState)(""),msg=_m[0],setMsg=_m[1],_io=(0,n.useState)(!1),impOpen=_io[0],setImpOpen=_io[1],_it=(0,n.useState)(""),impText=_it[0],setImpText=_it[1],_pd=(0,n.useState)(null),ddOpen=_pd[0],setDdOpen=_pd[1];
var loadMcp=(0,n.useCallback)(function(){fetch("/api/lumo/v1/admin/mcp/servers").then(function(r){return r.ok?r.json():null}).then(function(j){setMcp(j?j.Servers||[]:null)}).catch(function(){})},[]);
(0,n.useEffect)(function(){loadMcp()},[loadMcp]);
if(!mcp)return(0,a.jsxs)("div",{className:"flex flex-column flex-nowrap *:min-size-auto gap-4",children:[(0,a.jsx)("style",{children:ZADMIN_CSS}),(0,a.jsx)(%SEC%,{icon:"Wrench",text:"MCP servers",subtext:"Model Context Protocol servers whose tools chats on this instance can use."}),(0,a.jsx)("div",{className:"flex flex-row flex-nowrap gap-2",children:(0,a.jsx)(%SPIN%.m,{size:"small"})})]});
var jsonReq=function(r){return r.json().then(function(j){return{ok:r.ok,j:j}})};
var mcpAct=function(id,action){setMcpBusy(!0),fetch("/api/lumo/v1/admin/mcp/servers/"+action,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({id:id})}).then(jsonReq).then(function(x){if(x.ok&&x.j.Server){var v=x.j.Server;setMcp(mcp.map(function(q){return q.id===v.id?Object.assign({},q,v):q})),setMsg(v.status==="error"?("FAIL:"+v.name+" failed: "+(v.error||"unknown error")):("OK:"+v.name+": "+v.status+(v.toolCount!=null?" — "+v.toolCount+" tool"+(v.toolCount===1?"":"s"):"")))}else setMsg("FAIL:"+(x.j&&x.j.Error?x.j.Error:"Failed"))}).catch(function(){setMsg("FAIL:Failed")}).finally(function(){return setMcpBusy(!1)})};
var mcpDel=function(id){window.confirm("Delete this MCP server and its tool permissions?")&&fetch("/api/lumo/v1/admin/mcp/servers",{method:"DELETE",headers:{"Content-Type":"application/json"},body:JSON.stringify({id:id})}).then(jsonReq).then(function(x){setMsg(x.ok?"OK:Server deleted":("FAIL:"+(x.j&&x.j.Error?x.j.Error:"Failed"))),setMcpForm(null),loadMcp()}).catch(function(){setMsg("FAIL:Failed")})};
var mcpToggleTool=function(s,tname,on){var tp={};var src=s.toolPermissions||{};Object.keys(src).forEach(function(k2){tp[k2]=src[k2]});tp[tname]=on?"on":"off";setMcpBusy(!0),fetch("/api/lumo/v1/admin/mcp/servers",{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({Server:{id:s.id,name:s.name,transport:s.transport,command:s.command||"",args:s.args||[],cwd:s.cwd||"",url:s.url||"",enabled:s.enabled!==!1,trustedLocal:!!s.trustedLocal,auth:s.auth||"none",authHeaderName:s.authHeaderName||"Authorization",authHeaderPrefix:s.authHeaderPrefix||"Bearer",oauth:s.oauth?{authorizeUrl:s.oauth.authorizeUrl||"",tokenUrl:s.oauth.tokenUrl||"",clientId:s.oauth.clientId||"",scopes:s.oauth.scopes||"",usePkce:s.oauth.usePkce!==!1}:void 0,toolPermissions:tp}})}).then(jsonReq).then(function(x){if(x.ok&&x.j.Server){var v=x.j.Server;setMcp(mcp.map(function(q){return q.id===v.id?Object.assign({},q,v):q}))}else setMsg("FAIL:"+(x.j&&x.j.Error?x.j.Error:"Failed"))}).catch(function(){setMsg("FAIL:Failed")}).finally(function(){return setMcpBusy(!1)})};
var mcpNew=function(){setMcpForm({id:null,name:"",transport:"stdio",command:"",argsText:"",cwd:"",url:"",envRows:[],envClear:[],trustedLocal:!1,enabled:!0,auth:"none",authHeaderName:"Authorization",authHeaderPrefix:"Bearer",oauth:{authorizeUrl:"",tokenUrl:"",clientId:"",clientSecret:"",scopes:"",usePkce:!0,hasClientSecret:!1}})};
var mcpEdit=function(s){setMcpForm({id:s.id,name:s.name||"",transport:s.transport==="http"?"http":"stdio",command:s.command||"",argsText:(s.args||[]).join("\\n"),cwd:s.cwd||"",url:s.url||"",envRows:(s.envKeys||[]).map(function(k2){return{k:k2,v:""}}),envClear:[],trustedLocal:!!s.trustedLocal,enabled:s.enabled!==!1,auth:s.auth||"none",authHeaderName:s.authHeaderName||"Authorization",authHeaderPrefix:s.authHeaderPrefix||"Bearer",oauth:{authorizeUrl:(s.oauth&&s.oauth.authorizeUrl)||"",tokenUrl:(s.oauth&&s.oauth.tokenUrl)||"",clientId:(s.oauth&&s.oauth.clientId)||"",clientSecret:"",scopes:(s.oauth&&s.oauth.scopes)||"",usePkce:!(s.oauth&&s.oauth.usePkce===!1),hasClientSecret:!!(s.oauth&&s.oauth.hasClientSecret)}})};
var mcpSave=function(){var f=mcpForm;if(!f)return;setMcpBusy(!0);var payload={id:f.id||void 0,name:f.name,transport:f.transport,command:f.transport==="stdio"?f.command.trim():"",args:f.transport==="stdio"?f.argsText.split("\\n").map(function(x){return x.trim()}).filter(Boolean):[],cwd:f.transport==="stdio"&&f.cwd.trim()?f.cwd.trim():void 0,url:f.transport==="http"?f.url.trim():void 0,enabled:f.enabled!==!1,trustedLocal:f.transport==="http"&&f.trustedLocal,env:{},envClear:f.envClear,auth:f.transport==="http"?f.auth||"none":"none",authHeaderName:f.authHeaderName||"Authorization",authHeaderPrefix:f.authHeaderPrefix||"Bearer",oauth:f.auth==="oauth"?{authorizeUrl:f.oauth.authorizeUrl.trim(),tokenUrl:f.oauth.tokenUrl.trim(),clientId:f.oauth.clientId.trim(),scopes:f.oauth.scopes.trim(),usePkce:f.oauth.usePkce!==!1,clientSecret:f.oauth.clientSecret?f.oauth.clientSecret:f.oauth.hasClientSecret?void 0:null}:void 0};f.envRows.forEach(function(r2){r2.k.trim()&&r2.v&&(payload.env[r2.k.trim()]=r2.v)}),fetch("/api/lumo/v1/admin/mcp/servers",{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({Server:payload})}).then(jsonReq).then(function(x){if(x.ok)setMcpForm(null),setMsg("OK:Saved — use Connect to (re)load its tools."),loadMcp();else setMsg("FAIL:"+(x.j&&x.j.Error?x.j.Error:"Failed to save"))}).catch(function(){setMsg("FAIL:Failed to save")}).finally(function(){return setMcpBusy(!1)})};
var mcpImport=function(){setMcpBusy(!0),fetch("/api/lumo/v1/admin/mcp/import",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({config:impText})}).then(jsonReq).then(function(x){if(x.ok){var n2=(x.j.Imported||[]).length,errs=x.j.Errors||[];setMsg("OK:Imported "+n2+" server(s) — they start disabled. "+errs.join("; ")),setImpOpen(!1),setImpText(""),loadMcp()}else setMsg("FAIL:"+(x.j&&x.j.Error?x.j.Error:"Import failed"))}).catch(function(){setMsg("FAIL:Import failed")}).finally(function(){return setMcpBusy(!1)})};
var mcpExport=function(){fetch("/api/lumo/v1/admin/mcp/export").then(function(r){return r.ok?r.json():null}).then(function(j){if(!j)return;var blob=new Blob([JSON.stringify({mcpServers:j.mcpServers||{}},null,2)],{type:"application/json"}),url=URL.createObjectURL(blob),lnk=document.createElement("a");lnk.href=url,lnk.download="lumo-mcp-servers.json",lnk.click(),URL.revokeObjectURL(url),setMsg("OK:Export downloaded — env values are blanked for safety.")}).catch(function(){setMsg("FAIL:Export failed")})};
var dd=function(id,small,label,items,onPick){return(0,a.jsxs)("div",{className:"zap-dd"+(small?" zap-dd-sm":""),children:[(0,a.jsxs)("button",{type:"button",className:"zap-dd-btn",onClick:function(){return setDdOpen(ddOpen===id?null:id)},children:[(0,a.jsx)("span",{className:"zap-dd-txt",children:(0,a.jsx)("span",{className:"zap-dd-name",children:label})}),(0,a.jsx)("span",{className:"zap-dd-caret",children:"▼"})]}),ddOpen===id?(0,a.jsx)("div",{className:"zap-dd-overlay",onClick:function(){return setDdOpen(null)}}):null,ddOpen===id?(0,a.jsx)("div",{className:"zap-dd-menu",children:items.map(function(it,i){return(0,a.jsxs)("button",{type:"button",className:"zap-dd-item"+(it.on?" zap-dd-item-on":""),onClick:function(){onPick(it.v),setDdOpen(null)},children:[(0,a.jsxs)("span",{className:"zap-dd-txt",children:[(0,a.jsx)("span",{className:"zap-dd-name",children:it.label}),it.sub?(0,a.jsx)("span",{className:"zap-dd-url",children:it.sub}):null]}),it.on?(0,a.jsx)("span",{className:"zap-dd-check",children:"✓"}):null]},it.v+"-"+i)})}):null]})};
var msgEl=msg?(0,a.jsx)("span",{className:msg.indexOf("OK:")===0?"color-success text-sm":msg.indexOf("FAIL:")===0?"color-danger text-sm":"color-weak text-sm",children:msg.replace(/^(OK:|FAIL:)/,"")}):null;
return(0,a.jsxs)("div",{className:"flex flex-column flex-nowrap *:min-size-auto gap-4",children:[(0,a.jsx)("style",{children:ZADMIN_CSS}),(0,a.jsx)(%SEC%,{icon:"Wrench",text:"MCP servers",subtext:"Model Context Protocol servers whose tools chats on this instance can use.",button:(0,a.jsxs)("div",{className:"flex flex-row flex-nowrap gap-2",children:[(0,a.jsx)(%BTN%.$,{shape:"outline",size:"small",onClick:mcpNew,children:"+ Add server"}),(0,a.jsx)(%BTN%.$,{shape:"outline",size:"small",onClick:function(){return setImpOpen(!impOpen)},children:"Import"}),(0,a.jsx)(%BTN%.$,{shape:"outline",size:"small",onClick:mcpExport,children:"Export"})]})}),msgEl,impOpen?(0,a.jsxs)("div",{className:"flex flex-column gap-2",children:[(0,a.jsx)("textarea",{value:impText,placeholder:'{"mcpServers":{"my-server":{"command":"npx","args":["-y","@modelcontextprotocol/server-filesystem","/data"]}}}',onChange:function(e){return setImpText(e.target.value)},style:{background:"var(--background-norm)",border:"1px solid var(--border-weak)",borderRadius:8,padding:"8px 10px",color:"var(--text-norm,#fafafa)",font:"inherit",fontSize:".9em",outline:"none",width:"100%",minWidth:0,resize:"vertical"},rows:5}),(0,a.jsxs)("div",{className:"flex flex-row flex-nowrap items-center gap-2",children:[(0,a.jsx)(%BTN%.$,{color:"norm",size:"small",disabled:!impText.trim()||mcpBusy,onClick:mcpImport,children:"Import servers"}),(0,a.jsx)("span",{className:"color-weak text-sm",children:"Paste a standard mcpServers config. Imported servers start disabled."})]})]}):null,mcp.length===0?(0,a.jsx)("span",{className:"zap-empty",children:"No MCP servers configured yet — chats run without tools until you add and enable one."}):mcp.map(function(s){return(0,a.jsxs)("div",{className:"flex flex-column gap-2",children:[(0,a.jsx)(%SEC%,{icon:"Wrench",text:s.name||s.id,subtext:[s.transport,s.auth&&s.auth!=="none"?"auth: "+s.auth+(s.connections&&s.connections.length?" · "+s.connections.length+" connection(s)":""):"",s.toolCount+" tool"+(s.toolCount===1?"":"s"),s.status==="error"?s.error:s.status].filter(Boolean).join(" · "),button:(0,a.jsxs)("div",{className:"flex flex-row flex-nowrap gap-2",children:[(0,a.jsx)("span",{className:"zap-dot zap-dot-"+s.status,style:{marginTop:6}}),s.status==="connected"?(0,a.jsx)(%BTN%.$,{shape:"ghost",size:"small",disabled:mcpBusy,onClick:function(){return mcpAct(s.id,"disconnect")},children:"Disconnect"}):(0,a.jsx)(%BTN%.$,{shape:"ghost",size:"small",disabled:mcpBusy,onClick:function(){return mcpAct(s.id,"connect")},children:"Connect"}),(0,a.jsx)(%BTN%.$,{shape:"ghost",size:"small",disabled:mcpBusy,onClick:function(){return mcpAct(s.id,"test")},children:"Test"}),(0,a.jsx)(%BTN%.$,{shape:"ghost",size:"small",onClick:function(){return mcpEdit(s)},children:"Edit"}),(0,a.jsx)(%BTN%.$,{shape:"outline",color:"danger",size:"small",onClick:function(){return mcpDel(s.id)},children:"Delete"})]})}),s.tools&&s.tools.length?(0,a.jsx)("div",{className:"zap-mlist",style:{paddingLeft:8},children:s.tools.map(function(t){return(0,a.jsxs)("label",{className:"zap-chip"+(t.enabled?" zap-chip-on":""),title:(t.classification?t.classification+": ":"")+(t.description||t.name),children:[(0,a.jsx)("input",{type:"checkbox",checked:!!t.enabled,onChange:function(){return mcpToggleTool(s,t.name,!t.enabled)}}),(0,a.jsx)("span",{children:t.name+(t.classification==="write"?" ⚠":"")})]},s.id+"-"+t.name)})}):null]},s.id)}),mcpForm?(0,a.jsxs)("div",{className:"flex flex-column gap-2",style:{background:"var(--background-weak)",borderRadius:12,padding:16},children:[(0,a.jsx)("span",{className:"text-semibold",children:mcpForm.id?"Edit server":"New server"}),(0,a.jsx)(%INPUT%.Ay,{id:"zap-m-name",label:"Server name",placeholder:"e.g. Filesystem",value:mcpForm.name,assistContainerClassName:"hidden",onChange:function(e){return setMcpForm(Object.assign({},mcpForm,{name:e.target.value}))}}),dd("mcp-tr",!1,mcpForm.transport,[{v:"stdio",label:"stdio — local command",on:mcpForm.transport==="stdio"},{v:"http",label:"HTTP — remote URL",on:mcpForm.transport==="http"}],function(v){return setMcpForm(Object.assign({},mcpForm,{transport:v}))}),mcpForm.transport==="stdio"?(0,a.jsxs)("div",{className:"flex flex-column gap-2",children:[(0,a.jsx)(%INPUT%.Ay,{id:"zap-m-cmd",label:"Command",placeholder:"e.g. npx",value:mcpForm.command,assistContainerClassName:"hidden",onChange:function(e){return setMcpForm(Object.assign({},mcpForm,{command:e.target.value}))}}),(0,a.jsx)("textarea",{value:mcpForm.argsText,placeholder:"Arguments, one per line\\n-y\\n@modelcontextprotocol/server-filesystem\\n/data",onChange:function(e){return setMcpForm(Object.assign({},mcpForm,{argsText:e.target.value}))},style:{background:"var(--background-norm)",border:"1px solid var(--border-weak)",borderRadius:8,padding:"8px 10px",color:"var(--text-norm,#fafafa)",font:"inherit",fontSize:".9em",outline:"none",width:"100%",minWidth:0,resize:"vertical"},rows:3}),(0,a.jsx)(%INPUT%.Ay,{id:"zap-m-cwd",label:"Working directory (optional)",placeholder:"Optional",value:mcpForm.cwd,assistContainerClassName:"hidden",onChange:function(e){return setMcpForm(Object.assign({},mcpForm,{cwd:e.target.value}))}})]}):(0,a.jsx)(%INPUT%.Ay,{id:"zap-m-url",label:"Server URL",placeholder:"https://example.com/mcp",value:mcpForm.url,assistContainerClassName:"hidden",onChange:function(e){return setMcpForm(Object.assign({},mcpForm,{url:e.target.value}))}}),dd("mcp-auth",!1,mcpForm.auth==="none"?"Shared — administrator credentials":mcpForm.auth==="api_key"?"API key — each user connects their own":"OAuth 2.0 — per-user authorization",[{v:"none",label:"Shared — administrator credentials (env/headers)",on:mcpForm.auth==="none"},{v:"api_key",label:"API key — each user connects with their own key",on:mcpForm.auth==="api_key"},{v:"oauth",label:"OAuth 2.0 — per-user authorization flow",on:mcpForm.auth==="oauth"}],function(v){return setMcpForm(Object.assign({},mcpForm,{auth:v}))}),(0,a.jsxs)("div",{className:"flex flex-column gap-2",children:[(0,a.jsxs)("div",{className:"flex flex-row flex-nowrap items-baseline justify-space-between gap-2",children:[(0,a.jsx)("span",{className:"text-semibold text-sm",children:"Environment variables"}),(0,a.jsx)(%BTN%.$,{shape:"outline",size:"small",onClick:function(){return setMcpForm(Object.assign({},mcpForm,{envRows:mcpForm.envRows.concat([{k:"",v:""}])}))},children:"+ Add variable"})]}),mcpForm.envRows.length===0?(0,a.jsx)("span",{className:"color-weak text-sm",children:"None — variables are passed to the server process (stdio) and never shown or exported."}):mcpForm.envRows.map(function(row,ri){return(0,a.jsxs)("div",{className:"flex flex-row flex-nowrap items-end gap-2 w-full",children:[(0,a.jsx)("input",{value:row.k,placeholder:"NAME",style:{background:"var(--background-norm)",border:"1px solid var(--border-weak)",borderRadius:8,padding:"7px 10px",color:"var(--text-norm,#fafafa)",font:"inherit",fontSize:".9em",outline:"none",width:"100%",minWidth:0},onChange:function(e){return setMcpForm(Object.assign({},mcpForm,{envRows:mcpForm.envRows.map(function(r2,i2){return i2===ri?{k:e.target.value,v:r2.v}:r2})}))}}),(0,a.jsx)("input",{type:"password",value:row.v,placeholder:"value",style:{background:"var(--background-norm)",border:"1px solid var(--border-weak)",borderRadius:8,padding:"7px 10px",color:"var(--text-norm,#fafafa)",font:"inherit",fontSize:".9em",outline:"none",width:"100%",minWidth:0},onChange:function(e){return setMcpForm(Object.assign({},mcpForm,{envRows:mcpForm.envRows.map(function(r2,i2){return i2===ri?{k:r2.k,v:e.target.value}:r2})}))}}),(0,a.jsx)(%BTN%.$,{shape:"ghost",size:"small",onClick:function(){var cl=mcpForm.envClear.slice();return row.k&&cl.indexOf(row.k)===-1&&cl.push(row.k),setMcpForm(Object.assign({},mcpForm,{envRows:mcpForm.envRows.filter(function(r2,i2){return i2!==ri}),envClear:cl}))},children:"✕"})]},ri)})]}),(0,a.jsxs)("label",{className:"zap-chip"+(mcpForm.enabled?" zap-chip-on":""),children:[(0,a.jsx)("input",{type:"checkbox",checked:!!mcpForm.enabled,onChange:function(e){return setMcpForm(Object.assign({},mcpForm,{enabled:e.target.checked}))}}),(0,a.jsx)("span",{children:"Enabled — its enabled tools are available to chats"})]}),(0,a.jsxs)("div",{className:"flex flex-row flex-nowrap items-center gap-2",children:[(0,a.jsx)(%BTN%.$,{color:"norm",size:"small",loading:mcpBusy,onClick:mcpSave,children:"Save server"}),(0,a.jsx)(%BTN%.$,{shape:"ghost",size:"small",onClick:function(){return setMcpForm(null)},children:"Cancel"})]})]}):null]})};`;

// ── makeWrapper: admin-role check, renders panelName or a read-only message ──
// tabId is the settings switch key (e.g. "users", "mcp-servers").
function makeWrapper(wrapperName, panelName, tabId) {
    // The AI Provider tab has a read-only fallback for non-admins (shows the
    // catalog). Users and MCP tabs are admin-only — non-admins get a notice.
    if (tabId === 'ai-provider') {
        return `let ${wrapperName}=()=>{let _me=(0,n.useState)(-1),rol=_me[0],setRol=_me[1],_cc=(0,n.useState)(null),prs=_cc[0],setPrs=_cc[1];(0,n.useEffect)(function(){fetch("/api/lumo/v1/me").then(function(r){return r.ok?r.json():null}).then(function(j){return setRol(j&&j.Role===1?1:0)}).catch(function(){return setRol(0)})},[]);(0,n.useEffect)(function(){if(rol!==0)return;fetch("/api/lumo/v1/catalog").then(function(r){return r.ok?r.json():null}).then(function(j){if(!j)return setPrs([]);var mp=j.ModelProviders||{};setPrs((j.Providers||[]).map(function(p){return{Id:p.Id,Name:p.Name,BaseUrl:p.BaseUrl,models:Object.keys(mp).filter(function(m){return mp[m]===p.Id})}}))}).catch(function(){return setPrs([])})},[rol]);if(rol===1)return(0,a.jsx)(${panelName},{});return(0,a.jsxs)("div",{className:"flex flex-column flex-nowrap *:min-size-auto gap-4",children:[(0,a.jsx)("style",{children:ZADMIN_CSS}),(0,a.jsx)(%SEC%,{icon:"Cpu",text:"AI providers",subtext:"Providers and models for this instance are configured by your administrator."}),rol===-1?(0,a.jsx)("div",{className:"flex flex-row flex-nowrap gap-2",children:(0,a.jsx)(%SPIN%.m,{size:"small"})}):null,rol===0&&prs&&(prs.length===0?(0,a.jsx)("span",{className:"color-weak text-sm",children:"No providers configured yet — your administrator can add them here."}):prs.map(function(pr){return(0,a.jsx)(%SEC%,{icon:"Cpu",text:pr.Name||pr.BaseUrl||"Provider",subtext:pr.BaseUrl||"",button:pr.models.length?(0,a.jsx)("span",{className:"color-weak text-sm",children:pr.models.length+" model"+(pr.models.length===1?"":"s")}):null},pr.Id)}))]})};`;
    }
    // admin-only tabs (Users, MCP Servers)
    return `let ${wrapperName}=()=>{let _me=(0,n.useState)(-1),rol=_me[0],setRol=_me[1];(0,n.useEffect)(function(){fetch("/api/lumo/v1/me").then(function(r){return r.ok?r.json():null}).then(function(j){return setRol(j&&j.Role===1?1:0)}).catch(function(){return setRol(0)})},[]);if(rol===1)return(0,a.jsx)(${panelName},{});if(rol===0)return(0,a.jsxs)("div",{className:"flex flex-column flex-nowrap *:min-size-auto gap-4",children:[(0,a.jsx)("style",{children:ZADMIN_CSS}),(0,a.jsx)(%SEC%,{icon:${tabId === 'users' ? '"User"' : '"Wrench"'},text:${tabId === 'users' ? '"Users"' : '"MCP servers"'},subtext:"This section is only available to administrators."}),(0,a.jsx)("span",{className:"color-weak text-sm",children:"You need administrator access to manage "+(${tabId === 'users' ? '"users"' : '"MCP servers"'})+"."})]});return(0,a.jsxs)("div",{className:"flex flex-column flex-nowrap *:min-size-auto gap-4",children:[(0,a.jsx)("style",{children:ZADMIN_CSS}),(0,a.jsx)("div",{className:"flex flex-row flex-nowrap gap-2",children:(0,a.jsx)(%SPIN%.m,{size:"small"})})]})};`;
}

// Per-chunk config. The aliases are the native building-block module bindings.
// ICON is the Lucide icon component (H.z) — same module binding used by the
// native n8 SectionHeader for its settings-section-icon.
const ALIASES = {
    '1306.43935624.chunk.js': { SEC: 'n8', BTN: 'k', BANNER: 'ep', INPUT: 'nw', SPIN: 'av', ICON: 'H', formName: 'la', wrapperBase: 'la', navArr: 'l_' },
    '4124.6ffe79b5.chunk.js': { SEC: 'n$', BTN: 'k', BANNER: 'eh', INPUT: 'nt', SPIN: 'r8', ICON: 'H', formName: 'nG', wrapperBase: 'nG', navArr: 'lo' },
};
function fillTokens(code, alias) {
    return code
        .split('%SEC%').join(alias.SEC)
        .split('%BTN%').join(alias.BTN)
        .split('%BANNER%').join(alias.BANNER)
        .split('%INPUT%').join(alias.INPUT)
        .split('%SPIN%').join(alias.SPIN)
        .split('%ICON%').join(alias.ICON);
}

// ── nav entry + switch-case snippets to insert ──────────────────────────────
function navEntries() {
    // Inserted right after the ai-provider entry. Uses the same getText pattern.
    return ',{id:"users",icon:"Users",getText:()=>(0,o.c)("collider_2025: Settings Item").t`Users`,guest:!1}' +
           ',{id:"mcp-servers",icon:"Wrench",getText:()=>(0,o.c)("collider_2025: Settings Item").t`MCP Servers`,guest:!1}';
}

// ── apply the patch to one chunk ─────────────────────────────────────────────
const CHUNK_PREFIXES = { '1306.43935624.chunk.js': '1306', '4124.6ffe79b5.chunk.js': '4124' };

for (const [file, prefix] of Object.entries(CHUNK_PREFIXES)) {
    const alias = ALIASES[file];
    const p = `${STATIC}/${file}`;
    let s = fs.readFileSync(p, 'utf8');

    // 1. Remove the old injected block: from "var ZADMIN_CSS=" to just before
    //    "let <formName>=()=>{" (the original read-only component).
    const zcssStart = s.indexOf('var ZADMIN_CSS=');
    if (zcssStart === -1) {
        console.log(`${file}: no existing ZADMIN_CSS found — fresh chunk, injecting before form`);
        // fall back: inject right before the form definition
    } else {
        const formDef = `let ${alias.formName}=()=>{`;
        const formIdx = s.indexOf(formDef, zcssStart);
        if (formIdx === -1) throw new Error(`${file}: could not find ${formDef} after ZADMIN_CSS`);
        s = s.slice(0, zcssStart) + s.slice(formIdx);
        console.log(`${file}: removed old injected block (${formIdx - zcssStart} chars)`);
    }

    // 2. Build the new injection block.
    const block =
        'var ZADMIN_CSS=' + JSON.stringify(ZADMIN_CSS) + ';' +
        fillTokens(ZPROV_PANEL, alias) +
        fillTokens(ZUSERS_PANEL, alias) +
        fillTokens(ZMCP_PANEL, alias) +
        fillTokens(makeWrapper(alias.wrapperBase + '2', 'ZProvPanel', 'ai-provider'), alias) +
        fillTokens(makeWrapper(alias.wrapperBase + '3', 'ZUsersPanel', 'users'), alias) +
        fillTokens(makeWrapper(alias.wrapperBase + '4', 'ZMcpPanel', 'mcp-servers'), alias);

    // 3. Inject before "let <formName>=()=>{".
    const formDef = `let ${alias.formName}=()=>{`;
    const formIdx = s.indexOf(formDef);
    if (formIdx === -1) throw new Error(`${file}: could not find ${formDef} for injection`);
    s = s.slice(0, formIdx) + block + s.slice(formIdx);
    console.log(`${file}: injected new block (${block.length} chars)`);

    // 4. Fix the AI Provider switch case → la2/nG2 (overwrite any prior swap).
    const w2 = alias.wrapperBase + '2';
    const w3 = alias.wrapperBase + '3';
    const w4 = alias.wrapperBase + '4';
    const aiSwitchOld = new RegExp(`"ai-provider"===s&&\\(0,a\\.jsx\\)\\([a-zA-Z0-9_]+,\\{\\}\\)`);
    if (aiSwitchOld.test(s)) {
        s = s.replace(aiSwitchOld, `"ai-provider"===s&&(0,a.jsx)(${w2},{})`);
        console.log(`${file}: ai-provider switch -> ${w2}`);
    }

    // 5. Add Users + MCP switch cases (if not already present).
    if (s.indexOf(`"users"===s&&(0,a.jsx)(${w3},{})`) === -1) {
        // Insert after the ai-provider case.
        s = s.replace(
            `"ai-provider"===s&&(0,a.jsx)(${w2},{})`,
            `"ai-provider"===s&&(0,a.jsx)(${w2},{})` +
            `,"users"===s&&(0,a.jsx)(${w3},{})` +
            `,"mcp-servers"===s&&(0,a.jsx)(${w4},{})`
        );
        console.log(`${file}: added users+mcp switch cases`);
    }

    // 6. Add nav entries after the ai-provider entry (if not already present).
    const navAnchor = `id:"ai-provider",icon:"Cpu",getText:()=>(0,o.c)("collider_2025: Settings Item").t\`AI Provider\`,guest:!0}`;
    if (s.indexOf(navAnchor + navEntries()) === -1 && s.indexOf('id:"users",icon:"Users"') === -1) {
        if (s.indexOf(navAnchor) === -1) {
            console.log(`${file}: WARNING — ai-provider nav anchor not found, skipping nav insert`);
        } else {
            s = s.replace(navAnchor, navAnchor + navEntries());
            console.log(`${file}: added users+mcp nav entries`);
        }
    } else {
        console.log(`${file}: nav entries already present`);
    }

    fs.writeFileSync(p, s);
    console.log(`${file}: written`);
}

// ── recompute SRI for the two patched chunks across all runtimes ─────────────
const runtimeFiles = fs.readdirSync(STATIC).filter(f => /^runtime\.[a-f0-9]+\.js$/.test(f));
let touchedRuntimes = 0;
for (const rf of runtimeFiles) {
    const rp = `${STATIC}/${rf}`;
    let rt = fs.readFileSync(rp, 'utf8');
    let dirty = false;
    for (const prefix of ['1306', '4124']) {
        const urlM = rt.match(new RegExp(`${prefix}===s\\?"assets\\/static\\/(${prefix}\\.[a-f0-9]+)\\.chunk\\.js(\\?v=\\d+)?"`));
        if (!urlM) continue;
        const chunkId = urlM[1];
        const chunkPath = `${STATIC}/${chunkId}.chunk.js`;
        if (!fs.existsSync(chunkPath)) continue;
        const b64 = sri(fs.readFileSync(chunkPath)).slice('sha384-'.length);
        const intgRe = new RegExp(`(${prefix}:"sha384-)[A-Za-z0-9+/=]+(")`);
        const intM = rt.match(intgRe);
        if (intM && intM[0] !== `${prefix}:"sha384-${b64}"`) {
            rt = rt.replace(intgRe, `$1${b64}$2`);
            dirty = true;
        }
        const urlRe = new RegExp(`"assets/static/${chunkId.replace(/[.]/g, '\\.')}\\.chunk\\.js(\\?v=\\d+)?"`);
        if (urlRe.test(rt)) {
            rt = rt.replace(urlRe, `"assets/static/${chunkId}.chunk.js?${VERSION}"`);
            dirty = true;
        }
    }
    if (dirty) {
        fs.writeFileSync(rp, rt);
        touchedRuntimes++;
        console.log(`fixed SRI ${rf}`);
    }
}
console.log(`runtimes updated: ${touchedRuntimes}`);

// ── re-bump the boot runtime tag in index.html ──────────────────────────────
const indexPath = `${DIST}/index.html`;
let index = fs.readFileSync(indexPath, 'utf8');
const rtTagRe = /src="\/assets\/static\/(runtime\.[a-f0-9]+)\.js(\?v=\d+)?" integrity="sha384-[^"]+"/;
const m = index.match(rtTagRe);
if (!m) throw new Error('runtime script tag not found in index.html');
const runtimeHash = sri(fs.readFileSync(`${STATIC}/${m[1]}.js`));
index = index.replace(rtTagRe, `src="/assets/static/${m[1]}.js?${VERSION}" integrity="${runtimeHash}"`);
fs.writeFileSync(indexPath, index);
console.log(`bumped ${m[1]}.js in index.html -> ?${VERSION}`);

// ── verify: 0 SRI mismatches ─────────────────────────────────────────────────
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
if (mm !== 0) process.exit(1);
