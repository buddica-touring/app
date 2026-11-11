// 個別URL（staff.html）専用の通知SW（2026-11-11 高松。那覇・札幌と同じ）。scope は staff.html だけ。キャッシュの横取りはしない（fetch ハンドラなし）。
self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));
self.addEventListener('push',e=>{let d={};try{d=e.data.json();}catch(_){d={title:'BUDDICA',body:e.data?e.data.text():''};}
  e.waitUntil(self.registration.showNotification(d.title||'BUDDICA',{body:d.body||'',icon:'bc-logo.png',badge:'bc-logo.png',requireInteraction:true})
   .then(()=>self.registration.getNotifications()).then(ns=>{try{return self.navigator.setAppBadge&&self.navigator.setAppBadge(ns.length||1);}catch(_){}}));});
self.addEventListener('notificationclick',e=>{e.notification.close();e.waitUntil((async()=>{
  const cs=await self.clients.matchAll({type:'window',includeUncontrolled:true});
  for(const c of cs){if(/staff\.html/.test(c.url)&&'focus'in c)return c.focus();}
  let url='staff.html';try{const r=await caches.match('/__staff_push_me_bt');if(r)url=await r.text();}catch(_){}
  return self.clients.openWindow(url);})());});
