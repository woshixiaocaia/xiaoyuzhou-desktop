import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createPinia, setActivePinia } from 'pinia'
const require = createRequire(import.meta.url)
const { createOfficialClient } = require('../electron/official-client.cjs')
const { useOfficialStore } = await import('@/stores/official')
const { useAccountStore } = await import('@/stores/account')
const { useSettingsStore } = await import('@/stores/settings')
const { usePlayerStore } = await import('@/stores/player')
const { useQueueStore } = await import('@/stores/queue')
function fresh(overrides = {}) {
  const values = new Map()
  globalThis.localStorage = { getItem: k => values.get(k) ?? null, setItem: (k,v) => values.set(k,v) }
  globalThis.desktop = { officialAuthStart: async()=>({ok:true,id:'qr',url:'https://example.com/qr'}), officialAuthPoll:async()=>({ok:true,status:'WAITTING'}), officialAuthStatus:async()=>({ok:true,loggedIn:false,storageAvailable:true}), officialAuthLogout:async()=>({ok:true}), officialSubscriptions:async()=>({ok:true,payload:{data:[]}}),officialEpisodes:async()=>({ok:true,payload:{data:[]}}),officialMediaUrl:async()=>({ok:false}),officialSearch:async()=>({ok:true,payload:{data:[]}}), ...overrides }
  setActivePinia(createPinia())
  return values
}
test('会话重置同时清空搜索与发现内容', () => {
  fresh(); const store = useOfficialStore()
  store.searchKeyword='old'; store.discoverKeyword='old'; store.searchPodcasts=[{pid:'old'}]; store.discoverPodcasts=[{pid:'old'}]
  store.reset()
  assert.equal(store.searchKeyword,''); assert.equal(store.discoverKeyword,''); assert.deepEqual(store.searchPodcasts,[]); assert.deepEqual(store.discoverPodcasts,[])
})
test('重置后，旧订阅请求不能写回前一个账号的数据', async () => {
  let resolve; fresh({ officialSubscriptions:()=>new Promise(r=>{resolve=r}) }); const store=useOfficialStore()
  const pending=store.loadSubscriptions(); store.reset(); resolve({ok:true,payload:{data:[{pid:'old'}]}}); await pending
  assert.deepEqual(store.podcasts,[]);assert.equal(store.listStatus,'idle')
})
test('重置后，旧单集请求不能重新填充缓存', async () => {
  let resolve; fresh({ officialEpisodes:()=>new Promise(r=>{resolve=r}) }); const store=useOfficialStore()
  const pending=store.loadEpisodes('old');store.reset();resolve({ok:true,payload:{data:[{eid:'old',pid:'old'}]}});await pending
  assert.deepEqual(store.episodes,{})
})
test('重置后，旧搜索请求不能重新显示内容', async () => {
  let resolve;fresh({officialSearch:()=>new Promise(r=>{resolve=r})});const store=useOfficialStore()
  const pending=store.runSearch('old');store.reset();resolve({ok:true,payload:{data:[{type:'PODCAST',podcast:{pid:'old'}}]}});await pending
  assert.equal(store.searchStatus,'idle');assert.deepEqual(store.searchPodcasts,[])
})
test('取消期间迟到的二维码不能重新开启轮询', async () => {
  let resolve;fresh({officialAuthStart:()=>new Promise(r=>{resolve=r})});const account=useAccountStore()
  const pending=account.startLogin();account.cancel();resolve({ok:true,id:'late',url:'https://example.com/qr'});await pending
  assert.equal(account.phase,'idle');assert.equal(account.qrId,'')
})
test('退出失败保留账号状态并显示错误', async () => {
  fresh({officialAuthLogout:async()=>({ok:false,code:'STORAGE_CLEAR_FAILED',message:'删除凭据失败'})})
  const account=useAccountStore();account.phase='authorized';account.user={uid:'u',nickname:'name',avatar:''};await account.logout()
  assert.equal(account.isLoggedIn,true);assert.equal(account.errorMessage,'删除凭据失败')
})
test('主进程退出失败不谎报成功，不丢弃当前会话', () => {
  const client=createOfficialClient({transport:async()=>null,storage:{load:()=>({access:'test'}),clear:()=>({ok:false,code:'STORAGE_CLEAR_FAILED'})}})
  assert.equal(client.logout().ok,false);assert.equal(client.hasSession(),true)
})
test('退出后迟到的扫码成功响应不能恢复会话', async () => {
  let resolve;let saved=0
  const client=createOfficialClient({transport:()=>new Promise(r=>{resolve=r}),storage:{load:()=>null,clear:()=>({ok:true}),save:()=>{saved++;return {ok:true}}}})
  const pending=client.pollLogin('qr');client.logout();resolve({status:200,headers:{'x-jike-access-token':'late'},body:JSON.stringify({status:'CONFIRMED'})});await pending
  assert.equal(client.hasSession(),false);assert.equal(saved,0)
})
test('退出后迟到的令牌刷新不能恢复会话', async () => {
  let resolve;let saved=0
  const client=createOfficialClient({transport:()=>new Promise(r=>{resolve=r}),storage:{load:()=>({access:'old',refresh:'refresh'}),clear:()=>({ok:true}),save:()=>{saved++;return {ok:true}}}})
  const pending=client.refresh();client.logout();resolve({status:200,headers:{'x-jike-access-token':'late'},body:'{}'});await pending
  assert.equal(client.hasSession(),false);assert.equal(saved,0)
})
test('并发刷新只发送一次请求', async () => {
  let resolve,calls=0
  const client=createOfficialClient({transport:()=>{calls++;return new Promise(r=>{resolve=r})},storage:{load:()=>({access:'old',refresh:'refresh'}),clear:()=>({ok:true}),save:()=>({ok:true})}})
  const a=client.refresh(),b=client.refresh();resolve({status:200,headers:{'x-jike-access-token':'new','x-jike-refresh-token':'next'},body:'{}'});await Promise.all([a,b]);assert.equal(calls,1)
})
test('偏好设置可跨实例恢复，包括音量、主题与倍速', () => {
  fresh();const settings=useSettingsStore();settings.theme='dark';settings.volume=.3;settings.rate=1.5;settings.autoplay=false;settings.resume=false
  setActivePinia(createPinia());const restored=useSettingsStore()
  assert.equal(restored.theme,'dark');assert.equal(restored.volume,.3);assert.equal(restored.rate,1.5);assert.equal(restored.autoplay,false);assert.equal(restored.resume,false)
})
test('损坏的设置安全回退到默认值', () => {
  fresh();globalThis.localStorage.getItem=()=>'{broken';const settings=useSettingsStore()
  assert.equal(settings.theme,'system');assert.equal(settings.volume,.8);assert.equal(settings.autoplay,true)
})
test('播放器拒绝非法音量和倍速', () => {
  fresh();const player=usePlayerStore();player.setVolume(2);assert.equal(player.volume,1);player.setVolume(-1);assert.equal(player.volume,0);player.setVolume(NaN);assert.equal(player.volume,0)
  player.setPlaybackRate(1.5);player.setPlaybackRate(Infinity);player.setPlaybackRate(0);assert.equal(player.playbackRate,1.5)
})
test('直接播放已在队列中的单集时同步索引', () => {
  fresh();const queue=useQueueStore();const a={key:'rss:a',source:'rss',id:'a',title:'a',podcast:'p',duration:10,audioUrl:'https://example.com/a.mp3'};const b={...a,key:'rss:b',id:'b'}
  queue.add(a);queue.add(b);queue.syncCurrent(b);assert.equal(queue.index,1);assert.equal(queue.items.length,2)
})

test('退出官方账号时保留 RSS 队列项', () => {
  fresh();const queue=useQueueStore();const rss={key:'rss:a',source:'rss',id:'a',title:'a',podcast:'p',duration:10,audioUrl:'https://example.com/a.mp3'}
  queue.add(rss);queue.add({...rss,key:'official:b',source:'official'});queue.removeSource('official')
  assert.deepEqual(queue.items.map(i=>i.key),['rss:a']);assert.equal(queue.index,0)
})

test('只返回新 access 时保留现有 refresh 凭据', async () => {
  let saved
  const client=createOfficialClient({transport:async()=>({status:200,headers:{'x-jike-access-token':'new'},body:'{}'}),storage:{load:()=>({access:'old',refresh:'keep'}),save:s=>{saved=s;return {ok:true}},clear:()=>({ok:true})}})
  await client.refresh();assert.equal(saved.access,'new');assert.equal(saved.refresh,'keep')
})
