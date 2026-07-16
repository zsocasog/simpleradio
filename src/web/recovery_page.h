#pragma once

#include <Arduino.h>

static const char RECOVERY_PAGE[] PROGMEM = R"HTML(
<!doctype html>
<html lang="hu">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>SimpleRadio recovery</title>
  <style>
    :root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:#07100c;color:#edf7f0;font:16px system-ui,sans-serif;min-height:100vh;display:grid;place-items:center;padding:20px}.card{width:min(680px,100%);background:#101a15;border:1px solid #294236;border-radius:18px;padding:24px;box-shadow:0 18px 60px #0008}h1{margin:0 0 8px;color:#a9f7bf}p{line-height:1.5;color:#b9c8bf}.versions{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:20px 0}.item,.upload{background:#09110d;border:1px solid #263a30;border-radius:12px;padding:14px}.item small{display:block;color:#82948a}.item strong{display:block;margin-top:5px}.reason{border-left:4px solid #ffcc66;padding:10px 12px;background:#241d0f;color:#ffe2a7;border-radius:8px}label{display:block;margin-top:14px}.check{display:flex;gap:10px;align-items:center}.check input{width:20px;height:20px}input[type=password],input[type=file]{width:100%;margin-top:7px;background:#07100c;color:#fff;border:1px solid #365244;border-radius:9px;padding:11px}button{width:100%;margin-top:10px;padding:12px;border:0;border-radius:9px;background:#a9f7bf;color:#07100c;font-weight:800;cursor:pointer}.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:16px}.status{min-height:24px;margin-top:16px;color:#a9f7bf}.bar{height:7px;background:#07100c;border-radius:10px;overflow:hidden;margin-top:8px}.bar span{display:block;width:0;height:100%;background:#a9f7bf}@media(max-width:600px){.grid,.versions{grid-template-columns:1fr}}
  </style>
</head>
<body>
  <main class="card">
    <h1>SimpleRadio helyreállítás / recovery</h1>
    <p>A firmware és a WebUI/data nem kompatibilis. A normál kezelőfelület védelmi okból nem indult el.</p>
    <div class="versions">
      <div class="item"><small>Firmware</small><strong>__FW_VERSION__ (API __FW_API__)</strong></div>
      <div class="item"><small>WebUI/data</small><strong>__UI_VERSION__ (API __UI_API__)</strong></div>
    </div>
    <div class="reason">__REASON__</div>
    <label class="check"><input id="confirm" type="checkbox"> Megértettem / I understand</label>
    <label>OTA jelszó / password<input id="password" type="password" autocomplete="off"></label>
    <div class="grid">
      <div class="upload"><strong>Firmware</strong><input id="firmware" type="file" accept=".bin"><button onclick="upload('firmware')">Firmware feltöltése</button></div>
      <div class="upload"><strong>WebUI / LittleFS</strong><input id="filesystem" type="file" accept=".bin"><button onclick="upload('filesystem')">Data feltöltése</button></div>
    </div>
    <div class="bar"><span id="bar"></span></div>
    <div id="status" class="status">Válaszd ki a megfelelő frissítőfájlt.</div>
  </main>
  <script>
    function status(t,bad){const e=document.getElementById('status');e.textContent=t;e.style.color=bad?'#ff8b8b':'#a9f7bf'}
    function upload(kind){const file=document.getElementById(kind).files[0],pass=document.getElementById('password').value;if(!document.getElementById('confirm').checked)return status('A megerősítés szükséges.',true);if(!pass)return status('Az OTA jelszó szükséges.',true);if(!file)return status('Nincs kiválasztott fájl.',true);const x=new XMLHttpRequest();x.upload.onprogress=e=>{if(e.lengthComputable)document.getElementById('bar').style.width=(e.loaded/e.total*100)+'%'};x.onload=()=>{let d={};try{d=JSON.parse(x.responseText)}catch(e){}if(x.status>=200&&x.status<300&&d.ok){status('Feltöltés kész, újraindulás...');setTimeout(()=>location.href='/',5000)}else status(d.error||('Sikertelen feltöltés: '+x.status),true)};x.onerror=()=>status('Hálózati hiba a feltöltés közben.',true);x.open('POST','/api/ota/'+kind+'?confirm=1');x.setRequestHeader('Content-Type','application/octet-stream');x.setRequestHeader('X-SimpleRadio-OTA-Password',pass);status('Feltöltés: '+file.name);x.send(file)}
  </script>
</body>
</html>
)HTML";
