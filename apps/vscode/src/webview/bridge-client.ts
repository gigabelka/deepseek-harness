/** Page-side transport installed ahead of every `dsh web` boot script. */

/**
 * Source of the inline script that installs the page's transport hooks.
 *
 * It runs before the boot scripts read `globalThis.__DSH_TRANSPORT__`, so the
 * client's `createWebConnectionRpc` picks up this carrier instead of HTTP and
 * the Gateway WebSocket. `ownsHost: true` restores `connection.isLoopback`,
 * which would otherwise be false for the webview's `vscode-webview://`
 * authority — the same claim `apps/desktop-host` makes for the same reason.
 *
 * Authored as a string because it executes in the webview, not in the extension
 * host; `apps/desktop-host` states its transport the same way.
 */
export const BRIDGE_SCRIPT = String.raw`(function(){
var vscode=acquireVsCodeApi()
var seq=0
var pending=new Map()
var streams=new Map()
function nextId(){seq+=1;return 'b'+seq}
function toBase64(bytes){
  var out='',step=0x8000
  for(var i=0;i<bytes.length;i+=step){
    out+=String.fromCharCode.apply(null,Array.from(bytes.subarray(i,i+step)))
  }
  return btoa(out)
}
// Response normalizes every body the client sends: JSON strings from the RPC
// caller, and Blob or byte streams from the file-upload service.
function encodeBody(body){
  if(body===undefined||body===null)return Promise.resolve(undefined)
  return new Response(body).arrayBuffer().then(function(buffer){
    return toBase64(new Uint8Array(buffer))
  })
}
function decodeBody(text){
  var binary=atob(text),bytes=new Uint8Array(binary.length)
  for(var i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i)
  return bytes
}
window.addEventListener('message',function(event){
  var message=event.data
  if(message===null||typeof message!=='object')return
  if(message.kind==='fetch-result'||message.kind==='fetch-error'){
    var settle=pending.get(message.id)
    if(settle===undefined)return
    pending.delete(message.id)
    if(message.kind==='fetch-error'){settle.reject(new Error(message.message));return}
    settle.resolve(new Response(decodeBody(message.body),{status:message.status,headers:message.headers}))
    return
  }
  var stream=streams.get(message.id)
  if(stream===undefined)return
  if(message.kind==='stream-item'){stream.push({done:false,value:message.value});return}
  streams.delete(message.id)
  if(message.kind==='stream-end')stream.push({done:true})
  else if(message.kind==='stream-error')stream.fail(new Error(message.message))
})
function bridgeFetch(input,init){
  var options=init||{}
  var url=new URL(String(input),'http://dsh.internal')
  var id=nextId()
  var headers={}
  new Headers(options.headers||{}).forEach(function(value,name){headers[name]=value})
  var message={kind:'fetch',id:id,method:options.method||'GET',path:url.pathname+url.search,headers:headers}
  return new Promise(function(resolve,reject){
    pending.set(id,{resolve:resolve,reject:reject})
    if(options.signal!==undefined&&options.signal!==null){
      options.signal.addEventListener('abort',function(){
        if(!pending.delete(id))return
        reject(new DOMException('aborted','AbortError'))
      },{once:true})
    }
    encodeBody(options.body).then(function(body){
      if(!pending.has(id))return
      if(body!==undefined)message.body=body
      vscode.postMessage(message)
    },function(error){
      if(!pending.delete(id))return
      reject(error)
    })
  })
}
function openStream(endpoint,payload,signal){
  var id=nextId()
  var queue=[],waiting=null,finished=false,failure=null
  function deliver(){
    if(waiting===null)return
    if(failure!==null){var reject=waiting.reject;waiting=null;reject(failure);return}
    if(queue.length===0)return
    var resolve=waiting.resolve;waiting=null;resolve(queue.shift())
  }
  var sink={
    push:function(item){queue.push(item);if(item.done)finished=true;deliver()},
    fail:function(error){failure=error;finished=true;deliver()}
  }
  streams.set(id,sink)
  vscode.postMessage({kind:'stream-open',id:id,endpoint:endpoint,payload:payload})
  function cancel(){
    if(finished)return
    finished=true
    streams.delete(id)
    vscode.postMessage({kind:'stream-cancel',id:id})
  }
  if(signal!==undefined&&signal!==null)signal.addEventListener('abort',cancel,{once:true})
  return{
    [Symbol.asyncIterator]:function(){
      return{
        next:function(){
          if(queue.length>0)return Promise.resolve(queue.shift())
          if(failure!==null)return Promise.reject(failure)
          if(finished)return Promise.resolve({done:true})
          return new Promise(function(resolve,reject){waiting={resolve:resolve,reject:reject}})
        },
        return:function(){cancel();return Promise.resolve({done:true})}
      }
    }
  }
}
globalThis.__DSH_TRANSPORT__={ownsHost:true,fetch:bridgeFetch,openStream:openStream}
globalThis.__DSH_FILE_UPLOAD__={fetch:bridgeFetch}
})()`
