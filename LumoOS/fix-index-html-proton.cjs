// Clean up index.html: remove all Proton URLs, branding, and metadata.
// This makes the app fully self-hosted with no external Proton references.
const fs = require('fs');

const indexPath = '/home/z/my-project/LumoOS/lumo-dist/index.html';
let html = fs.readFileSync(indexPath, 'utf8');

// 1. Remove prefetch/canonical links to proton.me
html = html.replace(/<link rel="canonical" href="https:\/\/lumo\.proton\.me\/"\/>/g, '');
html = html.replace(/<link rel="prefetch" href="https:\/\/account\.proton\.me\/lumo\/signup"\/>/g, '');
html = html.replace(/<link rel="prefetch" href="https:\/\/account\.proton\.me\/lumo"\/>/g, '');

// 2. Update title and meta description (remove "by Proton")
html = html.replace(
    /<title>Lumo: Privacy-first AI assistant where chats stay confidential<\/title>/,
    '<title>Lumo — Self-hosted AI Assistant</title>'
);
html = html.replace(
    /content="Meet Lumo, the zero-access encrypted AI assistant by Proton that does not track or record your conversations. Ask me anything — it's confidential"/g,
    'content="Lumo — a self-hosted AI assistant. Your conversations stay on your server."'
);

// 3. Update OpenGraph metadata (remove proton.me URLs)
html = html.replace(/content="https:\/\/lumo\.proton\.me\/"/g, 'content="/"');
html = html.replace(/content="https:\/\/lumo\.proton\.me\/images\/social\/lumo-og\.png"/g, 'content="/assets/favicon.ico"');
html = html.replace(/content="https:\/\/lumo\.proton\.me\/images\/social\/lumo-by-proton\.png"/g, 'content="/assets/favicon.ico"');

// 4. Update Twitter metadata
html = html.replace(/content="@ProtonPrivacy"/g, 'content=""');
html = html.replace(/content="https:\/\/lumo\.proton\.me\/images\/social\/lumo-og\.png"/g, 'content="/assets/favicon.ico"');

// 5. Remove app store metadata (mobile app redirects)
html = html.replace(/<meta name="google-play-app" content="app-id=me\.proton\.android\.lumo"\/>/g, '');
html = html.replace(/<meta name="apple-itunes-app" content="app-id=6746714949"\/>/g, '');

// 6. Replace the JSON-LD structured data (remove all proton.me references)
// Replace the entire script block with a minimal self-hosted version
html = html.replace(
    /<script type="application\/ld\+json">[\s\S]*?<\/script>/,
    `<script type="application/ld+json">{"@context":"https://schema.org","@type":"WebApplication","name":"Lumo","description":"Self-hosted AI assistant","url":"/","applicationCategory":"AIAssistant"}</script>`
);

// 7. Update the footer link text in the chunks (By Proton, For Business)
// These are in the chunk JS, not index.html — handled separately below.

fs.writeFileSync(indexPath, html);
console.log('index.html cleaned: removed Proton URLs, branding, and metadata');

// Verify
const remaining = html.match(/proton\.[a-z]+/gi) || [];
console.log(`Remaining proton references in index.html: ${remaining.length}`);
if (remaining.length > 0) {
    console.log('Remaining:', [...new Set(remaining)]);
}
