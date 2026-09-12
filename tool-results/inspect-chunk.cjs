const fs = require('fs');
const html = fs.readFileSync('/home/z/SL9-SELENE/LumoOS/lumo-dist/index.html', 'utf8');
const re = /<script[^>]*>/g;
let m;
while ((m = re.exec(html)) !== null) {
  if (m[0].includes('runtime') || m[0].includes('src=')) console.log(m[0], '\n');
}
