/**
 * Webview Panel — renders in the secondary sidebar (right side of VS Code).
 *
 * Feature 1: Always-visible command status banner (success/error/warning/running)
 * Feature 2: Jump-to-line buttons next to errors
 * Feature 4: Lives in secondary sidebar, terminal stays at bottom
 */

import * as vscode from 'vscode';
import { FilteredEntry, FilterStats, VerbosityLevel } from './filterEngine';
import { StackTraceGrouper } from './stackTraceGrouper';

export class WebviewPanel implements vscode.WebviewViewProvider {
  public static readonly viewType = 'smartTerminal.panelView';
  private view: vscode.WebviewView | null = null;
  private pendingMessages: any[] = [];

  constructor(private context: vscode.ExtensionContext) {}

  resolveWebviewView(webviewView: vscode.WebviewView, _ctx: vscode.WebviewViewResolveContext, _token: vscode.CancellationToken): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true, localResourceRoots: [] };
    webviewView.webview.html = this.getHtml();
    webviewView.webview.onDidReceiveMessage(msg => this.handleMessage(msg), undefined, this.context.subscriptions);
    webviewView.onDidDispose(() => { this.view = null; });
    for (const msg of this.pendingMessages) { webviewView.webview.postMessage(msg); }
    this.pendingMessages = [];
  }

  show(): void {
    if (this.view) { this.view.show?.(true); }
    else { vscode.commands.executeCommand('smartTerminal.panelView.focus'); }
  }

  isVisible(): boolean { return this.view !== null && this.view.visible; }

  // --- Messaging ---
  sendEntry(entry: FilteredEntry): void { this.post({ type: 'addEntry', entry: this.serialize(entry) }); }
  sendBulkEntries(entries: FilteredEntry[]): void { this.post({ type: 'bulkEntries', entries: entries.map(e => this.serialize(e)) }); }
  sendStats(stats: FilterStats): void { this.post({ type: 'updateStats', stats }); }
  sendVerbosity(level: VerbosityLevel): void { this.post({ type: 'updateVerbosity', level }); }
  sendFrameworks(names: string[]): void { this.post({ type: 'updateFrameworks', frameworks: names }); }
  sendClear(): void { this.post({ type: 'clear' }); }
  sendAIStatus(enabled: boolean): void { this.post({ type: 'aiStatus', enabled }); }
  sendAILoading(message: string): void { this.post({ type: 'aiLoading', message }); }
  sendErrorExplanation(explanation: any): void { this.post({ type: 'errorExplanation', explanation }); }
  sendLogSummary(summary: any): void { this.post({ type: 'logSummary', summary }); }
  sendQueryResult(result: any): void { this.post({ type: 'queryResult', result }); }
  sendHideStackGroup(groupId: string): void { this.post({ type: 'hideStackGroup', groupId }); }
  sendHideEntry(lineNumber: number): void { this.post({ type: 'hideEntry', lineNumber }); }

  private post(message: any): void {
    if (this.view) { this.view.webview.postMessage(message); }
    else {
      this.pendingMessages.push(message);
      // Prevent unbounded memory growth; when the panel opens it receives fresh data via sendBulkEntries
      if (this.pendingMessages.length > 2000) {
        this.pendingMessages.splice(0, this.pendingMessages.length - 2000);
      }
    }
  }

  private serialize(entry: FilteredEntry) {
    return {
      cleaned: entry.line.cleaned, level: entry.line.level, category: entry.line.category,
      noiseScore: entry.line.noiseScore, timestamp: entry.line.timestamp, source: entry.line.source,
      isStackTraceLine: entry.line.isStackTraceLine, isFirstOfGroup: entry.line.isFirstOfGroup,
      lineNumber: entry.line.lineNumber, terminalName: entry.line.terminalName, visible: entry.visible,
      stackGroupId: entry.stackGroup?.id,
      stackGroupSummary: entry.stackGroup ? StackTraceGrouper.summarize(entry.stackGroup) : undefined,
      isStackGroupHeader: entry.isStackGroupHeader,
      stackFirstSource: entry.stackGroup ? entry.stackGroup.lines.find(l => l.source)?.source : undefined,
      errorCount: entry.errorCount,
    };
  }

  // --- Message handlers ---
  private messageHandlers: Map<string, (data: any) => void> = new Map();
  onMessage(type: string, handler: (data: any) => void): void { this.messageHandlers.set(type, handler); }
  private handleMessage(message: any): void {
    const handler = this.messageHandlers.get(message.type);
    if (handler) handler(message);
  }

  // --- HTML ---
  private getHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
:root{--bg:var(--vscode-editor-background);--fg:var(--vscode-editor-foreground);--border:var(--vscode-panel-border);--error:#f14c4c;--warn:#cca700;--info:#3794ff;--user:#4ec9b0;--status:#9cdcfe;--debug:#808080;--header-bg:var(--vscode-sideBarSectionHeader-background);--input-bg:var(--vscode-input-background);--input-fg:var(--vscode-input-foreground);--input-border:var(--vscode-input-border);--hover-bg:var(--vscode-list-hoverBackground);--badge-bg:var(--vscode-badge-background);--badge-fg:var(--vscode-badge-foreground)}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:var(--vscode-editor-font-family,'Consolas,monospace');font-size:13px;color:var(--fg);background:var(--bg);overflow-x:hidden}

.status-banner{display:flex;align-items:center;gap:8px;padding:8px 12px;font-size:12px;font-weight:500;border-bottom:1px solid var(--border)}
.status-banner.s-idle{background:transparent;color:var(--debug)}
.status-banner.s-running{background:rgba(78,201,176,0.12);color:var(--user)}
.status-banner.s-success{background:rgba(78,201,176,0.15);color:var(--user)}
.status-banner.s-warning{background:rgba(204,167,0,0.12);color:var(--warn)}
.status-banner.s-error{background:rgba(241,76,76,0.15);color:var(--error)}
.status-banner .s-icon{font-size:14px;flex-shrink:0}

.toolbar{display:flex;align-items:center;gap:4px;padding:4px 8px;border-bottom:1px solid var(--border);flex-wrap:wrap}
.toolbar input[type="text"]{flex:1;min-width:80px;padding:3px 6px;background:var(--input-bg);color:var(--input-fg);border:1px solid var(--input-border);border-radius:3px;font-size:11px;outline:none}
.toolbar input:focus{border-color:var(--vscode-focusBorder)}
.toolbar select,.toolbar button{padding:3px 6px;background:var(--input-bg);color:var(--input-fg);border:1px solid var(--input-border);border-radius:3px;font-size:10px;cursor:pointer}
.toolbar button:hover{background:var(--hover-bg)}
.v-slider{display:flex;align-items:center;gap:3px;font-size:10px}
.v-slider input[type="range"]{width:60px;accent-color:var(--info)}

.ai-bar{display:flex;align-items:center;gap:3px;padding:3px 8px;border-bottom:1px solid var(--border);background:rgba(127,119,221,0.04);flex-wrap:wrap}
.ai-bar .ai-lbl{font-size:9px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;color:#7F77DD;margin-right:2px}
.ai-bar button{padding:2px 6px;background:rgba(127,119,221,0.1);color:#7F77DD;border:1px solid rgba(127,119,221,0.25);border-radius:3px;font-size:10px;cursor:pointer}
.ai-bar button:hover{background:rgba(127,119,221,0.2)}
.ai-bar input[type="text"]{flex:1;min-width:60px;padding:2px 6px;background:var(--input-bg);color:var(--input-fg);border:1px solid var(--input-border);border-radius:3px;font-size:10px;outline:none}

.ai-panel{display:none;padding:8px 10px;border-bottom:1px solid var(--border);background:rgba(127,119,221,0.03);font-size:11px;line-height:1.5;max-height:220px;overflow-y:auto}
.ai-panel.visible{display:block}
.ai-panel .x{float:right;cursor:pointer;opacity:.4;font-size:13px}.ai-panel .x:hover{opacity:1}
.ai-panel h3{font-size:12px;font-weight:600;margin:6px 0 3px;color:#7F77DD}.ai-panel h3:first-child{margin-top:0}
.ai-panel pre{background:var(--vscode-textCodeBlock-background,rgba(0,0,0,.12));padding:5px 8px;border-radius:3px;overflow-x:auto;font-size:10px;margin:3px 0}
.ai-panel .badge{display:inline-block;padding:1px 6px;border-radius:6px;font-size:9px;font-weight:600;text-transform:uppercase}
.ai-panel .badge.success{background:rgba(78,201,176,.2);color:var(--user)}
.ai-panel .badge.warning{background:rgba(204,167,0,.2);color:var(--warn)}
.ai-panel .badge.error{background:rgba(241,76,76,.2);color:var(--error)}
.ai-panel .badge.neutral{background:rgba(128,128,128,.2);color:var(--debug)}
.ai-loading{display:none;padding:5px 10px;font-size:10px;color:#7F77DD;border-bottom:1px solid var(--border);animation:pulse 1.5s ease-in-out infinite}
.ai-loading.visible{display:block}
@keyframes pulse{0%,100%{opacity:.4}50%{opacity:1}}

.logs{overflow-y:auto;height:calc(100vh - 130px);padding:2px 0}

.log-line{display:flex;align-items:flex-start;padding:1px 8px;font-size:11px;line-height:1.55;border-left:3px solid transparent;transition:background .1s}
.log-line:hover{background:var(--hover-bg)}
.log-line.l-error{border-left-color:var(--error);color:var(--error)}
.log-line.l-warn{border-left-color:var(--warn);color:var(--warn)}
.log-line.l-user{border-left-color:var(--user);color:var(--user);font-weight:500}
.log-line.l-status{border-left-color:var(--status);color:var(--status)}
.log-line.l-info{opacity:.85}.log-line.l-debug{opacity:.5}.log-line.l-unknown{opacity:.65}
.log-line.l-trace{opacity:.4}
.log-line.stack{padding-left:20px;opacity:.7;font-size:10px}
.ln{min-width:30px;color:var(--debug);text-align:right;padding-right:6px;user-select:none;font-size:9px;opacity:.45}
.lc{flex:1;white-space:pre-wrap;word-break:break-all}
.src{color:var(--info);font-size:9px;padding-left:6px;white-space:nowrap;cursor:pointer;opacity:.5}
.src:hover{opacity:1;text-decoration:underline}

.jump{display:inline-flex;align-items:center;gap:2px;padding:1px 5px;margin-left:4px;background:rgba(55,148,255,.1);color:var(--info);border:1px solid rgba(55,148,255,.25);border-radius:3px;font-size:9px;cursor:pointer;white-space:nowrap;opacity:0;transition:opacity .12s}
.log-line:hover .jump{opacity:1}
.l-error .jump,.l-warn .jump{opacity:1}
.jump:hover{background:rgba(55,148,255,.22)}

.err-trend{display:inline-flex;padding:1px 6px;background:rgba(241,76,76,.15);color:var(--error);border:1px solid rgba(241,76,76,.3);border-radius:10px;font-size:9px;margin-left:6px;vertical-align:middle;white-space:nowrap}
.sg-hdr{display:flex;align-items:center;gap:5px;padding:3px 8px;background:rgba(241,76,76,.07);cursor:pointer;font-size:11px;border-left:3px solid var(--error);color:var(--error)}
.sg-hdr:hover{background:rgba(241,76,76,.13)}
.sg-tog{font-size:9px;transition:transform .12s}.sg-tog.open{transform:rotate(90deg)}
.sg-body{display:none}.sg-body.open{display:block}
.sg-cnt{font-size:9px;background:rgba(241,76,76,.15);padding:0 4px;border-radius:6px}

.hl{background:rgba(204,167,0,.3);border-radius:2px}
.empty{display:flex;flex-direction:column;align-items:center;justify-content:center;height:50vh;opacity:.45;text-align:center;font-size:12px}
.empty-hint{font-size:10px;margin-top:4px;opacity:.6}
</style>
</head>
<body>

<div class="status-banner s-idle" id="banner">
  <span class="s-icon" id="b-icon">&#9711;</span>
  <span id="b-msg">Waiting for terminal output...</span>
</div>

<div class="toolbar">
  <input type="text" id="search" placeholder="Search..." />
  <div class="v-slider"><span>V:</span><input type="range" id="verb" min="1" max="5" value="2" step="1"/><span id="verb-l">2</span></div>
  <select id="lvl-f"><option value="all">All</option><option value="error">Errors</option><option value="warn">Warnings</option><option value="user">My logs</option><option value="status">Status</option></select>
  <button id="b-clr">Clear</button>
  <button id="b-exp">Export</button>
</div>

<div class="ai-bar">
  <span class="ai-lbl">AI</span>
  <button id="b-expl">Explain Error</button>
  <button id="b-summ">Summarize</button>
  <input type="text" id="ai-q" placeholder='Ask: "slow queries" or "what crashed?"'/>
  <button id="b-ask">Ask</button>
</div>

<div class="ai-loading" id="ai-ld"></div>
<div class="ai-panel" id="ai-p"><span class="x" id="ai-x">&times;</span><div id="ai-c"></div></div>

<div class="logs" id="logs">
  <div class="empty" id="empty">
    <div style="font-size:24px;margin-bottom:6px;">&#9889;</div>
    <div>Waiting for terminal output...</div>
    <div class="empty-hint">Run a command in any VS Code terminal</div>
  </div>
</div>

<script>
var V=acquireVsCodeApi(),C=document.getElementById('logs'),E=document.getElementById('empty');
var entries=[],autoS=true,sTerm='',lvlF='all';
var SICONS={success:'\\u2713',error:'\\u2717',warning:'\\u26A0',running:'\\u21BB',idle:'\\u25CB'};

window.addEventListener('message',function(ev){
  var m=ev.data;
  switch(m.type){
    case 'addEntry':add(m.entry);break;
    case 'bulkEntries':entries=[];C.innerHTML='';E.style.display='flex';C.appendChild(E);m.entries.forEach(function(e){add(e)});break;
    case 'updateStats':uStats(m.stats);break;
    case 'updateVerbosity':document.getElementById('verb').value=m.level;document.getElementById('verb-l').textContent=m.level;break;
    case 'updateFrameworks':break;
    case 'clear':entries=[];C.innerHTML='';E.style.display='flex';C.appendChild(E);uBanner('idle','Waiting for terminal output...');aiP.classList.remove('visible');aiL.classList.remove('visible');aiC.innerHTML='';break;
    case 'aiLoading':showAILoad(m.message);break;
    case 'errorExplanation':rExpl(m.explanation);break;
    case 'logSummary':rSumm(m.summary);break;
    case 'queryResult':rQuery(m.result);break;
    case 'hideStackGroup':
      for(var i=0;i<entries.length;i++){if(entries[i].stackGroupId===m.groupId){entries[i].visible=false;}}
      var bd=document.getElementById('sgb-'+m.groupId);
      if(bd&&bd.parentNode){bd.parentNode.remove();}
      break;
    case 'hideEntry':
      for(var i=0;i<entries.length;i++){if(entries[i].lineNumber===m.lineNumber){entries[i].visible=false;}}
      var el=C.querySelector('[data-linenum="'+m.lineNumber+'"]');
      if(el){el.remove();}
      break;
  }
});

function uBanner(s,msg){var b=document.getElementById('banner');b.className='status-banner s-'+s;document.getElementById('b-icon').innerHTML=SICONS[s]||SICONS.idle;document.getElementById('b-msg').textContent=msg;}

function add(e){
  entries.push(e);
  if(E.parentNode===C)C.removeChild(E);
  if(!filt(e))return;
  if(e.isStackGroupHeader&&e.stackGroupId)C.appendChild(mkSG(e));
  else if(e.isStackTraceLine&&!e.isStackGroupHeader&&e.stackGroupId){var b=document.getElementById('sgb-'+e.stackGroupId);if(b)b.appendChild(mkLine(e));else C.appendChild(mkLine(e));}
  else C.appendChild(mkLine(e));
  if(autoS)C.scrollTop=C.scrollHeight;
}

function filt(e){
  if(!e.visible)return false;
  if(lvlF!=='all'&&e.level!==lvlF)return false;
  if(sTerm){try{var rx=sTerm.length<=200?new RegExp(sTerm,'i'):null;if(rx?!rx.test(e.cleaned):e.cleaned.toLowerCase().indexOf(sTerm.toLowerCase())===-1)return false}catch(x){if(e.cleaned.toLowerCase().indexOf(sTerm.toLowerCase())===-1)return false}}
  return true;
}

function mkLine(e){
  var d=document.createElement('div');
  d.setAttribute('data-linenum',e.lineNumber);
  d.className='log-line l-'+e.level;
  if(e.isStackTraceLine)d.classList.add('stack');
  var h='<span class="ln">'+e.lineNumber+'</span>';
  var c=esc(e.cleaned);
  if(sTerm&&sTerm.length<=200){try{c=c.replace(new RegExp('('+sTerm+')','gi'),'<span class="hl">$1</span>')}catch(x){}}
  h+='<span class="lc">'+c+'</span>';
  if(e.errorCount&&e.errorCount>1){var n=e.errorCount;var sfx=n===2?'nd':n===3?'rd':'th';h+='<span class="err-trend" title="This error has appeared '+n+' times">&#8635; '+n+sfx+' time</span>';}
  if(e.source&&(e.level==='error'||e.isStackTraceLine)){
    h+='<span class="jump" onclick="oF(\\''+esc(e.source)+'\\')">\\u2192 Go to line</span>';
  }else if(e.source){
    h+='<span class="src" onclick="oF(\\''+esc(e.source)+'\\')">'+esc(e.source)+'</span>';
  }
  d.innerHTML=h;return d;
}

function mkSG(e){
  var w=document.createElement('div');
  var hd=document.createElement('div');hd.className='sg-hdr';
  var jSrc=e.source||e.stackFirstSource;
  var jb=jSrc?'<span class="jump" onclick="event.stopPropagation();oF(\\''+esc(jSrc)+'\\')" style="opacity:1">\\u2192 Go to line</span>':'';
  var trendBadge='';if(e.errorCount&&e.errorCount>1){var n=e.errorCount;var sfx=n===2?'nd':n===3?'rd':'th';trendBadge='<span class="err-trend">&#8635; '+n+sfx+' time</span>';}
  hd.innerHTML='<span class="sg-tog" id="sgt-'+e.stackGroupId+'">\\u25B6</span><span style="flex:1">'+esc(e.cleaned)+'</span>'+trendBadge+jb+'<span class="sg-cnt">stack trace</span>';
  hd.onclick=function(){tSG(e.stackGroupId)};
  var bd=document.createElement('div');bd.className='sg-body';bd.id='sgb-'+e.stackGroupId;
  w.appendChild(hd);w.appendChild(bd);return w;
}

function tSG(id){var b=document.getElementById('sgb-'+id),t=document.getElementById('sgt-'+id);if(b&&t){b.classList.toggle('open');t.classList.toggle('open')}}

function uStats(s){
  uBanner(s.commandStatus||'idle',s.commandStatusMessage||'');
}

document.getElementById('search').addEventListener('input',function(e){sTerm=e.target.value;rerender()});
document.getElementById('lvl-f').addEventListener('change',function(e){lvlF=e.target.value;rerender()});
document.getElementById('verb').addEventListener('input',function(e){var v=parseInt(e.target.value,10);document.getElementById('verb-l').textContent=v;V.postMessage({type:'setVerbosity',level:v})});
document.getElementById('b-clr').addEventListener('click',function(){V.postMessage({type:'clearLogs'})});
document.getElementById('b-exp').addEventListener('click',function(){V.postMessage({type:'exportLogs'})});

function rerender(){C.innerHTML='';var n=0;for(var i=0;i<entries.length;i++){var e=entries[i];if(!filt(e))continue;n++;
if(e.isStackGroupHeader&&e.stackGroupId)C.appendChild(mkSG(e));
else if(e.isStackTraceLine&&e.stackGroupId){var b=document.getElementById('sgb-'+e.stackGroupId);if(b)b.appendChild(mkLine(e));else C.appendChild(mkLine(e));}
else C.appendChild(mkLine(e));}
if(n===0&&entries.length===0)C.appendChild(E);}

C.addEventListener('scroll',function(){autoS=C.scrollHeight-C.scrollTop-C.clientHeight<50});
function oF(s){V.postMessage({type:'openFile',source:s})}
function esc(t){var d=document.createElement('div');d.appendChild(document.createTextNode(t));return d.innerHTML}

var aiP=document.getElementById('ai-p'),aiC=document.getElementById('ai-c'),aiL=document.getElementById('ai-ld');
function showAIP(t,h){aiC.innerHTML='<h3>'+esc(t)+'</h3>'+h;aiP.classList.add('visible');aiL.classList.remove('visible')}
function showAILoad(m){aiL.textContent='\\u21BB '+m;aiL.classList.add('visible');aiP.classList.remove('visible')}
function safeConf(v){return(['high','medium','low'].indexOf(v)!==-1?v:'medium')}
function safeStat(v){return(['success','error','warning','neutral'].indexOf(v)!==-1?v:'neutral')}
function rExpl(x){aiL.classList.remove('visible');if(x.error){showAIP('AI Error','<p style="color:var(--error)">'+esc(x.error)+'</p>');return}
var h='<p><strong>'+esc(x.summary)+'</strong></p>';
if(x.rootCause)h+='<h3>Root cause</h3><p>'+esc(x.rootCause)+'</p>';
if(x.suggestedFix)h+='<h3>Suggested fix</h3><p>'+esc(x.suggestedFix)+'</p>';
if(x.codeSnippet)h+='<pre>'+esc(x.codeSnippet)+'</pre>';
var cv=safeConf(x.confidence);
h+='<div style="font-size:9px;opacity:.5;margin-top:4px"><span class="badge '+cv+'">'+cv.toUpperCase()+'</span> \\u00B7 '+(x.durationMs||0)+'ms</div>';
showAIP('Error explanation',h)}
function rSumm(s){aiL.classList.remove('visible');var sv=safeStat(s.status);var h='<span class="badge '+sv+'">'+sv.toUpperCase()+'</span> <p>'+esc(s.tldr||'')+'</p>';
if(s.keyEvents&&s.keyEvents.length>0){h+='<h3>Key events</h3><ul style="margin:3px 0;padding-left:16px">';s.keyEvents.forEach(function(e){h+='<li style="font-size:10px;margin:1px 0">'+esc(e)+'</li>'});h+='</ul>'}
showAIP('Log summary',h)}
function rQuery(r){aiL.classList.remove('visible');var h='<div style="font-size:9px;opacity:.5">Found <strong>'+r.matchedLines.length+'</strong> of '+r.totalScanned+(r.usedAI?' \\u00B7 AI':'')+' \\u00B7 '+(r.durationMs||0)+'ms</div>';
if(r.conversationalResponse){h+='<p style="font-size:11px;line-height:1.6;white-space:pre-wrap">'+esc(r.conversationalResponse)+'</p>';}else{h+='<p style="font-size:10px;opacity:.6">'+esc(r.explanation||'')+'</p>';}
if(r.matchedLines&&r.matchedLines.length>0){var mx=Math.min(r.matchedLines.length,60);h+='<div style="max-height:180px;overflow-y:auto;border:1px solid var(--border);border-radius:3px;padding:1px 0">';
for(var i=0;i<mx;i++){var l=r.matchedLines[i];h+='<div class="log-line l-'+(l.level||'unknown')+'" style="font-size:10px;padding:1px 6px"><span class="ln">'+(l.lineNumber||'')+'</span><span class="lc">'+esc(l.cleaned||'')+'</span></div>'}
if(r.matchedLines.length>mx)h+='<div style="text-align:center;font-size:9px;opacity:.4;padding:3px">... and '+(r.matchedLines.length-mx)+' more</div>';
h+='</div>'}else{h+='<p style="opacity:.4">No matches found.</p>'}
showAIP('Query results',h)}

document.getElementById('b-expl').addEventListener('click',function(){V.postMessage({type:'explainError'})});
document.getElementById('b-summ').addEventListener('click',function(){V.postMessage({type:'summarizeLogs'})});
document.getElementById('b-ask').addEventListener('click',function(){var q=document.getElementById('ai-q').value.trim();if(q)V.postMessage({type:'queryLogs',question:q})});
document.getElementById('ai-q').addEventListener('keydown',function(e){if(e.key==='Enter'){var q=e.target.value.trim();if(q)V.postMessage({type:'queryLogs',question:q})}});
document.getElementById('ai-x').addEventListener('click',function(){aiP.classList.remove('visible')});
</script>
</body></html>`;
  }

  dispose(): void { this.view = null; }
}
