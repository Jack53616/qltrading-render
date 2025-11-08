// Verify Telegram initData per docs: https://core.telegram.org/bots/webapps#validating-data-received-via-the-web-app
const crypto = require('crypto');

function checkTelegramInitData(initData, botToken){
  if(!initData || !botToken) return false;
  const urlParams = new URLSearchParams(initData);
  const hash = urlParams.get('hash');
  urlParams.delete('hash');
  const dataCheckString = Array.from(urlParams.entries())
    .sort((a,b)=> a[0].localeCompare(b[0]))
    .map(([k,v])=>`${k}=${v}`)
    .join('\n');
  const secret = crypto.createHmac('sha256','WebAppData').update(botToken).digest();
  const signature = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');
  return signature === hash;
}

function parseInitData(initData){
  const p = new URLSearchParams(initData);
  const user = p.get('user');
  let tg = null;
  try{ tg = user? JSON.parse(user): null; }catch{}
  return tg;
}

module.exports = { checkTelegramInitData, parseInitData };
