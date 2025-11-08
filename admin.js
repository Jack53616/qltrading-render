const $ = s => document.querySelector(s);
const api = (u, method='GET', data, token) =>
  fetch(u, {
    method,
    headers: Object.assign({'Content-Type':'application/json','x-admin-token': token||window._adm}, {}),
    body: data ? JSON.stringify(data) : undefined
  }).then(r=>r.json());

const loginBox = $('#login'), panel = $('#panel'), toast = $('#toast');
let token = '';

function showToast(t){ toast.textContent=t; toast.classList.add('show'); setTimeout(()=>toast.classList.remove('show'),1800); }

// تبويب
document.querySelectorAll('.tabs .t').forEach(b=>{
  b.onclick=()=>{
    document.querySelectorAll('.tabs .t').forEach(x=>x.classList.remove('on'));
    b.classList.add('on');
    document.querySelectorAll('.tab').forEach(t=>t.classList.remove('show'));
    $('#tab-'+b.dataset.tab).classList.add('show');
  };
});

// دخول الأدمن
$('#admBtn').onclick = async ()=>{
  token = $('#admTok').value.trim();
  if(!token) return $('#msg').textContent='أدخل التوكن من فضلك';
  // جرّب فقط طلب صغير لمعرفة إن التوكن صحيح
  const j = await api('/api/admin/stats', 'GET', null, token);
  if(!j.ok){ $('#msg').textContent='التوكن غير صحيح'; return; }
  window._adm = token;
  loginBox.classList.add('hidden'); panel.classList.remove('hidden');
  loadAll();
};

// تحميل الكل
async function loadAll(){ await Promise.all([loadStats(), loadUsers(), loadWds(), loadTrs()]); }

// إحصائيات
async function loadStats(){
  const j = await api('/api/admin/stats');
  if(!j.ok) return;
  $('#k-users').textContent = j.users;
  $('#k-dep').textContent   = '$'+Number(j.deposits).toFixed(2);
  $('#k-wd').textContent    = '$'+Number(j.withdrawals).toFixed(2);
  $('#k-open').textContent  = j.open_trades;
  const head = row(['#','النوع','القيمة','ملاحظة','وقت الإنشاء']);
  $('#recent').innerHTML = head + j.recent.map(r=>row([
    r.id, r.type, Number(r.amount||0).toFixed(2), r.note||'', new Date(r.created_at).toLocaleString()
  ])).join('');
}

// المستخدمون
$('#qbtn').onclick = loadUsers;
async function loadUsers(){
  const qv = $('#q').value||'';
  const j = await api('/api/admin/users?q='+encodeURIComponent(qv));
  if(!j.ok) return;
  const head = row(['ID','الاسم / TG','الرصيد','الاشتراك','إجراءات']);
  $('#users').innerHTML = head + j.items.map(u=>row([
    u.id,
    `${u.name||'-'}<br><small>${u.tg_id||''}</small>`,
    '$'+Number(u.balance||0).toFixed(2),
    u.sub_expires_at ? new Date(u.sub_expires_at).toLocaleDateString() : '—',
    `<button data-a="add" data-id="${u.id}" class="mini">+50</button>
     <button data-a="rem" data-id="${u.id}" class="mini">-50</button>`
  ])).join('');

  $('#users').onclick = async (e)=>{
    const b = e.target; const id=b.getAttribute('data-id'); const a=b.getAttribute('data-a');
    if(!id||!a) return;
    const delta = a==='add' ? 50 : -50;
    const j = await api('/api/admin/users/'+id+'/balance','POST',{delta, note:'panel adjust'});
    if(j.ok){ showToast('تم التعديل'); loadStats(); loadUsers(); }
  };
}

// السحوبات
async function loadWds(){
  const j = await api('/api/admin/withdrawals');
  if(!j.ok) return;
  const head = row(['ID','المستخدم','المبلغ','الطريقة','الحالة / إجراء']);
  $('#wds').innerHTML = head + j.items.map(w=>row([
    w.id, w.user_id, '$'+Number(w.amount||0).toFixed(2), w.method||'-',
    w.status==='pending'
      ? `<button data-a="ok" data-id="${w.id}" class="mini">قبول</button>
         <button data-a="no" data-id="${w.id}" class="mini">رفض</button>`
      : w.status
  ])).join('');

  $('#wds').onclick = async (e)=>{
    const b=e.target; const id=b.getAttribute('data-id'); const a=b.getAttribute('data-a');
    if(!id||!a) return;
    const url = a==='ok' ? '/api/admin/withdrawals/'+id+'/approve' : '/api/admin/withdrawals/'+id+'/reject';
    const j = await api(url,'POST', a==='no'? {reason:'panel'} : undefined);
    if(j.ok){ showToast(a==='ok'?'تم القبول':'تم الرفض'); loadWds(); loadStats(); }
  };
}

// الصفقات
async function loadTrs(){
  const j = await api('/api/admin/trades');
  if(!j.ok) return;
  const head = row(['ID','المستخدم','الرمز','الحالة','إجراء']);
  $('#trs').innerHTML = head + j.items.map(t=>row([
    t.id, t.user_id, t.symbol||'-', t.status,
    t.status==='open'
      ? `<button class="mini" data-a="close" data-id="${t.id}">إغلاق +20</button>`
      : (t.pnl!=null ? (Number(t.pnl)>=0?'+$'+Number(t.pnl).toFixed(2):'-$'+Math.abs(Number(t.pnl)).toFixed(2)) : '')
  ])).join('');

  $('#trs').onclick = async (e)=>{
    const b=e.target; const id=b.getAttribute('data-id'); const a=b.getAttribute('data-a');
    if(a==='close'){ const j=await api('/api/admin/trades/'+id+'/close','POST',{pnl:20}); if(j.ok){ showToast('أُغلقت الصفقة'); loadTrs(); loadStats(); } }
  };
}

// أداة رسم صف
function row(cols){ return `<div class="row">${cols.map(c=>`<div>${c??''}</div>`).join('')}</div>`; }
