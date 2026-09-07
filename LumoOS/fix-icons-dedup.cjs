// Fix: remove duplicate Add model button, replace emoji icons with Lucide icons,
// and improve the Add/Edit model modal consistency.
const fs = require('fs');
const p = '/home/z/my-project/LumoOS/fix-admin-ui-split.cjs';
let s = fs.readFileSync(p, 'utf8');
let changes = 0;

// ── 1. Remove the duplicate "+ Add model" button (the standalone one below
// the model list). The one in the Models header (next to "N total") stays.
// The duplicate is: (0,a.jsxs)("div",{className:"flex flex-row flex-nowrap items-end gap-2 w-full",children:[(0,a.jsx)(%BTN%.$,{shape:"outline",size:"small",onClick:openAddModel,children:"+ Add model"})]})
const dupAddBtn = '(0,a.jsxs)("div",{className:"flex flex-row flex-nowrap items-end gap-2 w-full",children:[(0,a.jsx)(%BTN%.$,{shape:"outline",size:"small",onClick:openAddModel,children:"+ Add model"})]})';
if (s.includes(dupAddBtn)) {
    // Remove it entirely (and the trailing comma if present)
    s = s.replace(dupAddBtn + ',', '');
    s = s.replace(dupAddBtn, '');
    changes++;
    console.log('OK: removed duplicate Add model button');
} else {
    console.log('SKIP: duplicate Add model button not found');
}

// ── 2. Replace emoji icons with Lucide icons (via %ICON%.z component).
// The icon buttons currently use emoji text children. Replace them with
// (0,a.jsx)(%ICON%.z,{name:"...",size:16}) which renders the native Lucide icon.

// Test connection: 🔌 → Zap (or RotateCw). Use "Zap" for test connection.
// While testing: ⏳ → "Hourglass" (already available in the icon set)
const testOld = 'children:testingModel===id?"\\u23F3":"\\u{1F50C}"';
const testNew = 'children:(0,a.jsx)(%ICON%.z,{name:testingModel===id?"Hourglass":"Zap",size:16})';
if (s.includes(testOld)) {
    s = s.replace(testOld, testNew);
    changes++;
    console.log('OK: replaced test connection emoji with Lucide Zap/Hourglass');
} else {
    console.log('SKIP: test connection emoji not found');
}

// Edit: ✎ → Pencil
const editOld = 'children:"\\u270E"';
const editNew = 'children:(0,a.jsx)(%ICON%.z,{name:"Pencil",size:16})';
if (s.includes(editOld)) {
    s = s.replace(editOld, editNew);
    changes++;
    console.log('OK: replaced edit emoji with Lucide Pencil');
} else {
    console.log('SKIP: edit emoji not found');
}

// Delete: 🗑 → Trash2
const delOld = 'children:"\\u{1F5D1}"';
const delNew = 'children:(0,a.jsx)(%ICON%.z,{name:"Trash2",size:16})';
if (s.includes(delOld)) {
    s = s.replace(delOld, delNew);
    changes++;
    console.log('OK: replaced delete emoji with Lucide Trash2');
} else {
    console.log('SKIP: delete emoji not found');
}

// ── 3. Replace the modal close button emoji ✕ with Lucide X icon ──────────
const closeOld = 'children:"\\u2715"})]}),(0,a.jsx)(%INPUT%.Ay,{id:"zap-mm-id"';
const closeNew = 'children:(0,a.jsx)(%ICON%.z,{name:"X",size:20})})]}),(0,a.jsx)(%INPUT%.Ay,{id:"zap-mm-id"';
if (s.includes(closeOld)) {
    s = s.replace(closeOld, closeNew);
    changes++;
    console.log('OK: replaced modal close emoji with Lucide X');
} else {
    console.log('SKIP: modal close emoji not found');
}

// ── 4. Replace the test result pill emoji ✓/✗ with Lucide Check/X ─────────
const okOld = 'children:"\\u2713 "+tr.msg';
const okNew = 'children:[(0,a.jsx)(%ICON%.z,{name:"Check",size:12}),tr.msg]';
if (s.includes(okOld)) {
    s = s.replace(okOld, okNew);
    changes++;
    console.log('OK: replaced test OK emoji with Lucide Check');
} else {
    console.log('SKIP: test OK emoji not found');
}

const failOld = 'children:"\\u2717 "+tr.msg';
const failNew = 'children:[(0,a.jsx)(%ICON%.z,{name:"X",size:12}),tr.msg]';
if (s.includes(failOld)) {
    s = s.replace(failOld, failNew);
    changes++;
    console.log('OK: replaced test FAIL emoji with Lucide X');
} else {
    console.log('SKIP: test FAIL emoji not found');
}

// ── 5. Replace the "+ Add provider"/"+ Add model" text with Lucide Plus icon ─
// This makes them consistent with native buttons that use icons.
// Actually, native buttons often just use text, so let's keep the text but
// make the Add Model button in the header use the icon.
// Skip — native Lumo buttons in settings use text, not icons.

// ── 6. Update the Add provider / Delete buttons to use icons too ───────────
// Native n8 SectionHeader buttons use the k.$ button with text. Let's keep
// text for consistency with native, but the Delete provider button could use
// Trash2 icon. Actually, native uses text buttons — let's keep text.

fs.writeFileSync(p, s);
console.log(`Done. ${changes} changes applied.`);
