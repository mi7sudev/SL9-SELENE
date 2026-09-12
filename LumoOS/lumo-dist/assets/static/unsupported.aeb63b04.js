"use strict";(globalThis.webpackChunkproton_lumo=globalThis.webpackChunkproton_lumo||[]).push([[4768],{48015(e,o,t){var r=t(17231),s=t(61395),n=t(41514),a=function(){var e=-1!==(document.location.origin||document.location.href).indexOf("protonvpn"),o=document.location.hostname,t=e?"https://protonvpn.com/support/browsers-supported/":"https://".concat(o.slice(o.indexOf(".")+1),"/support/recommended-browsers");document.body.innerHTML=`
        <div class='h-full flex items-center pb-14 overflow-auto'>
            <div class='m-auto text-center max-w-custom' style='--max-w-custom: 30em'>
                <h1 class='text-bold text-4xl'>Unsupported browser</h1>
                <p>
                    You are using an unsupported browser. Please update it to the latest version or use a different browser.
                </p>
                <a class='primary-link bold' target='_blank' rel='noopener noreferrer' href='`.concat(t,`'>More info</a>
                <div class='mt-8'>
                    <img src='`).concat(s,`' alt='Unsupported browser'/>
                </div>
            </div>
        </div>
    `),document.title="Unsupported browser"},i=function(){var e;document.body.innerHTML=`
        <div class='h-full flex items-center pb-14 overflow-auto'>
            <div class='m-auto text-center max-w-custom' style='--max-w-custom: 30em'>
                <div class='mb-8'>
                    <img src='`.concat(r,`' alt='Error'/>
                </div>
                <h1 class='text-bold text-4xl'>Oops, something went wrong</h1>
                <p>
                    Please <button id='refresh' class='link align-baseline'>refresh the page</button> or try again later.
                </p>
            </div>
        </div>
    `),null==(e=document.querySelector("#refresh"))||e.addEventListener("click",function(){window.location.reload()}),document.title="Oops, something went wrong"};window.setTimeout(function(){try{window.protonSupportedBrowser=n.y.Supported}catch(e){};window.protonSupportedBrowser===n.y.Unsupported?a():(window.protonSupportedBrowser===n.y.Other||void 0===window.protonSupportedBrowser)&&i()},33)},41514(e,o,t){t.d(o,{y:()=>s});var r,s=((r={})[r.Unsupported=0]="Unsupported",r[r.Supported=1]="Supported",r[r.Other=-1]="Other",r)},17231(e,o,t){e.exports=t.p+"assets/static/error-generic.bc8f0410913ef9902fd0.svg"},61395(e,o,t){e.exports=t.p+"assets/static/unsupported-browser.5ab97e5ab1e5c7cd836f.svg"}},e=>{e(e.s=48015)}]);
//# sourceMappingURL=unsupported.aeb63b04.js.map