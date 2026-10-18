// Inline board script. The CSP hashes these exact bytes (no remote script host).
// Collapse is per feature group, never the project lane. View in the query string
// wins; a bare "/" restores the last table choice from localStorage.
export const CLIENT_SCRIPT = `(function(){
var KEY="status-hub:collapsed-groups";
var VIEW="status-hub:view";
function read(){try{return JSON.parse(localStorage.getItem(KEY)||"{}")||{}}catch(e){return{}}}
function write(m){try{localStorage.setItem(KEY,JSON.stringify(m))}catch(e){}}
var map=read();
document.querySelectorAll("details.group[data-group]").forEach(function(el){
var id=el.getAttribute("data-group");
if(id&&map[id])el.removeAttribute("open");
el.addEventListener("toggle",function(){
if(!id)return;
var m=read();
if(el.open)delete m[id];else m[id]=1;
write(m);
});
});
document.querySelectorAll("input.g-toggle[data-group]").forEach(function(el){
var id=el.getAttribute("data-group");
if(id&&map[id])el.checked=false;
el.addEventListener("change",function(){
if(!id)return;
var m=read();
if(el.checked)delete m[id];else m[id]=1;
write(m);
});
});
function setAll(open){
var m=read();
document.querySelectorAll("details.group[data-group]").forEach(function(el){
el.open=open;
var id=el.getAttribute("data-group");
if(!id)return;
if(open)delete m[id];else m[id]=1;
});
document.querySelectorAll("input.g-toggle[data-group]").forEach(function(el){
el.checked=open;
var id=el.getAttribute("data-group");
if(!id)return;
if(open)delete m[id];else m[id]=1;
});
write(m);
}
var exp=document.getElementById("groups-expand");
var col=document.getElementById("groups-collapse");
if(exp)exp.addEventListener("click",function(){setAll(true)});
if(col)col.addEventListener("click",function(){setAll(false)});
document.querySelectorAll("tr.task-row").forEach(function(tr){
tr.addEventListener("click",function(ev){
var node=ev.target&&ev.target.nodeType===1?ev.target:ev.target&&ev.target.parentElement;
if(node&&node.closest&&node.closest("a,button,input,form,label,summary"))return;
var a=tr.querySelector("a.rowmain");
if(a)location.href=a.href;
});
});
var back=document.querySelector(".drawer-back");
if(back){
back.addEventListener("click",function(ev){
if(ev.target!==back)return;
var c=back.querySelector("a.drawer-close");
if(c)location.href=c.href;
});
document.addEventListener("keydown",function(ev){
if(ev.key!=="Escape")return;
var c=back.querySelector("a.drawer-close");
if(c)location.href=c.href;
});
}
if(location.pathname!=="/")return;
var params=new URLSearchParams(location.search);
var view=params.get("view");
if(view==="table"||view==="board"){
try{localStorage.setItem(VIEW,view)}catch(e){}
return;
}
var saved="";
try{saved=localStorage.getItem(VIEW)||""}catch(e){}
if(saved==="table"){
params.set("view","table");
location.replace(location.pathname+"?"+params.toString());
}
})();`;
