/* Backend for the standalone journal: Firebase login + Firestore sync, offline cache, backups. Exposes window.claude.use("db" | "downloads") like the original page expects. */
(function () {
  "use strict";
  var cfg = window.FIREBASE_CONFIG || {};
  var configured = cfg.apiKey && String(cfg.apiKey).indexOf("PASTE") < 0 && window.firebase;
  var fs = null, auth = null, uid = null, email = "";
  var COLS = ["sales", "tasks", "shifts"], DOCS = ["settings/main", "settings/pay"];

  function el(tag, attrs, html) { var e = document.createElement(tag); Object.keys(attrs || {}).forEach(function (k) { e.setAttribute(k, attrs[k]); }); if (html != null) e.innerHTML = html; return e; }
  function say(t) { var x = document.getElementById("toast"); if (!x) { alert(t); return; } x.textContent = t; x.classList.add("on"); clearTimeout(say._t); say._t = setTimeout(function () { x.classList.remove("on"); }, 3000); }
  function race(p) { return Promise.race([p, new Promise(function (r) { setTimeout(r, 1500); })]); }

  /* ---------- login screen ---------- */
  var gate = el("div", { id: "gate", role: "dialog", "aria-modal": "true" });
  gate.style.cssText = "position:fixed;inset:0;z-index:100;display:flex;align-items:center;justify-content:center;padding:20px;background:var(--bg,#f3f5f7);overflow:auto";
  function showGate(html) { gate.innerHTML = '<div style="width:100%;max-width:380px;background:var(--surface,#fff);color:var(--ink,#101418);border:1px solid var(--line,#e0e5ea);border-radius:12px;padding:22px;font-family:var(--font-sans,sans-serif)">' + html + "</div>"; if (!gate.parentNode) document.body.appendChild(gate); }
  function hideGate() { if (gate.parentNode) gate.parentNode.removeChild(gate); }
  var inp = "width:100%;height:42px;padding:0 12px;border:1px solid var(--line,#e0e5ea);border-radius:8px;background:var(--surface-2,#f7f9fb);color:inherit;font:inherit;margin-top:6px";
  var btn = "width:100%;height:44px;border-radius:8px;border:0;background:var(--accent,#2a78d6);color:var(--accent-ink,#fff);font:inherit;font-weight:600;margin-top:14px";
  var btn2 = "width:100%;height:42px;border-radius:8px;border:1px solid var(--line,#e0e5ea);background:transparent;color:inherit;font:inherit;margin-top:8px";
  function authError(e) {
    var c = e && e.code || "";
    if (c === "auth/invalid-credential" || c === "auth/wrong-password" || c === "auth/user-not-found" || c === "auth/invalid-login-credentials") return "Неверная почта или пароль";
    if (c === "auth/email-already-in-use") return "Эта почта уже зарегистрирована, нажмите «Войти»";
    if (c === "auth/weak-password") return "Пароль слишком короткий, нужно минимум 6 символов";
    if (c === "auth/invalid-email") return "Проверьте адрес почты";
    if (c === "auth/network-request-failed") return "Нет интернета";
    if (c === "auth/too-many-requests") return "Слишком много попыток, подождите немного";
    return "Не получилось войти: " + (c || (e && e.message) || "ошибка");
  }
  function loginScreen() {
    showGate('<h1 style="margin:0 0 4px;font-size:22px">Журнал продаж</h1><p style="margin:0 0 14px;color:var(--muted,#76808a);font-size:14px">Войдите, чтобы открыть свои данные</p>' +
      '<form id="gForm" autocomplete="on"><label style="font-size:12px;color:var(--muted,#76808a)">Почта<input id="gMail" type="email" autocomplete="username" required style="' + inp + '"></label>' +
      '<label style="font-size:12px;color:var(--muted,#76808a);display:block;margin-top:10px">Пароль<input id="gPass" type="password" autocomplete="current-password" minlength="6" required style="' + inp + '"></label>' +
      '<p id="gErr" style="color:var(--bad,#c93434);font-size:13px;min-height:18px;margin:10px 0 0"></p>' +
      '<button type="submit" style="' + btn + '">Войти</button><button type="button" id="gNew" style="' + btn2 + '">Создать аккаунт (первый раз)</button></form>');
    var f = document.getElementById("gForm"), err = document.getElementById("gErr");
    function go(create) {
      err.textContent = ""; var m = document.getElementById("gMail").value.trim(), p = document.getElementById("gPass").value;
      if (!m || p.length < 6) { err.textContent = "Введите почту и пароль от 6 символов"; return; }
      (create ? auth.createUserWithEmailAndPassword(m, p) : auth.signInWithEmailAndPassword(m, p)).catch(function (e) { err.textContent = authError(e); });
    }
    f.addEventListener("submit", function (e) { e.preventDefault(); go(false); });
    document.getElementById("gNew").addEventListener("click", function () { go(true); });
  }
  if (!configured) {
    showGate('<h1 style="margin:0 0 8px;font-size:20px">Нужна настройка</h1><p style="margin:0;font-size:14px;line-height:1.5">В файле <b>config.js</b> ещё не вставлены данные Firebase. Откройте инструкцию из README и вставьте настройки проекта.</p>');
  }

  /* ---------- database wrapper (same calls the page makes) ---------- */
  function wrap() {
    var base = "users/" + uid + "/";
    return {
      collection: function (c) {
        var r = fs.collection(base + c);
        return {
          onSnapshot: function (n, e) { return r.onSnapshot(n, e); },
          add: function (d) { var ref = r.doc(); return race(ref.set(d)).then(function () { return ref; }); }
        };
      },
      doc: function (p) {
        var r = fs.doc(base + p);
        return {
          set: function (d) { return race(r.set(d)); },
          update: function (d) { return race(r.update(d)); },
          delete: function () { return race(r.delete()); },
          onSnapshot: function (n, e) { return r.onSnapshot(n, e); }
        };
      }
    };
  }
  var resolveDb, dbReady = new Promise(function (r) { resolveDb = r; });

  /* ---------- files (csv, backup) ---------- */
  function saveFile(o) {
    return new Promise(function (resolve, reject) {
      try {
        var type = /\.json$/i.test(o.filename) ? "application/json" : "text/csv;charset=utf-8";
        var blob = new Blob([o.data], { type: type }), file = null;
        try { file = new File([blob], o.filename, { type: type }); } catch (e) {}
        if (file && navigator.canShare && navigator.canShare({ files: [file] }) && /iPhone|iPad/.test(navigator.userAgent)) {
          navigator.share({ files: [file] }).then(resolve, function (e) { if (e && e.name === "AbortError") reject({ code: "declined" }); else reject(e); });
          return;
        }
        var a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = o.filename; document.body.appendChild(a); a.click();
        setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000); resolve();
      } catch (e) { reject(e); }
    });
  }

  /* ---------- backup and restore ---------- */
  function backup() {
    var out = { app: "zhurnal-prodazh", version: 1, exportedAt: Date.now(), collections: {}, settings: {} }, base = "users/" + uid + "/";
    var jobs = COLS.map(function (c) { return fs.collection(base + c).get().then(function (s) { out.collections[c] = {}; s.docs.forEach(function (d) { out.collections[c][d.id] = d.data(); }); }); });
    DOCS.forEach(function (p) { jobs.push(fs.doc(base + p).get().then(function (d) { if (d.exists) out.settings[p.split("/")[1]] = d.data(); })); });
    Promise.all(jobs).then(function () {
      var d = new Date(), n = "zhurnal-kopiya-" + d.getFullYear() + "-" + ("0" + (d.getMonth() + 1)).slice(-2) + "-" + ("0" + d.getDate()).slice(-2) + ".json";
      return saveFile({ filename: n, data: JSON.stringify(out) });
    }).then(function () { say("Копия готова"); }, function (e) { if (!e || e.code !== "declined") say("Не удалось сделать копию"); });
  }
  function restore(file) {
    var r = new FileReader();
    r.onload = function () {
      var j; try { j = JSON.parse(String(r.result)); } catch (e) { say("Это не файл копии журнала"); return; }
      if (!j || !j.collections) { say("Это не файл копии журнала"); return; }
      var items = [], base = "users/" + uid + "/";
      COLS.forEach(function (c) { var m = j.collections[c] || {}; Object.keys(m).forEach(function (id) { items.push([base + c + "/" + id, m[id]]); }); });
      Object.keys(j.settings || {}).forEach(function (k) { items.push([base + "settings/" + k, j.settings[k]]); });
      if (!items.length) { say("В файле нет данных"); return; }
      if (!confirm("Загрузить " + items.length + " записей? Записи с теми же номерами будут перезаписаны.")) return;
      var chunks = [], i; for (i = 0; i < items.length; i += 400) chunks.push(items.slice(i, i + 400));
      chunks.reduce(function (p, ch) { return p.then(function () { var b = fs.batch(); ch.forEach(function (it) { b.set(fs.doc(it[0]), it[1]); }); return b.commit(); }); }, Promise.resolve())
        .then(function () { say("Данные загружены: " + items.length); }, function () { say("Не удалось загрузить данные"); });
    };
    r.readAsText(file);
  }
  function footer() {
    if (document.getElementById("appFoot")) return;
    var w = document.querySelector(".wrap"); if (!w) return;
    var f = el("div", { id: "appFoot" });
    f.style.cssText = "display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:space-between;font-size:13px;color:var(--muted,#76808a);margin-top:8px";
    var b = "border:1px solid var(--line,#e0e5ea);background:var(--surface,#fff);color:var(--ink,#101418);border-radius:6px;height:32px;padding:0 10px;font:inherit;font-size:13px";
    f.innerHTML = '<span>' + (email ? email.replace(/</g, "&lt;") : "") + '</span><span style="display:flex;gap:6px;flex-wrap:wrap"><button type="button" id="fBack" style="' + b + '">Скачать копию</button><button type="button" id="fRest" style="' + b + '">Загрузить копию</button><button type="button" id="fOut" style="' + b + '">Выйти</button></span><input type="file" id="fFile" accept=".json,application/json" hidden>';
    w.appendChild(f);
    document.getElementById("fBack").addEventListener("click", backup);
    document.getElementById("fRest").addEventListener("click", function () { document.getElementById("fFile").click(); });
    document.getElementById("fFile").addEventListener("change", function () { if (this.files && this.files[0]) restore(this.files[0]); this.value = ""; });
    document.getElementById("fOut").addEventListener("click", function () { if (confirm("Выйти из журнала на этом устройстве?")) auth.signOut().then(function () { location.reload(); }); });
  }

  /* ---------- start ---------- */
  if (configured) {
    try { firebase.initializeApp(cfg); } catch (e) {}
    fs = firebase.firestore(); auth = firebase.auth();
    fs.enablePersistence({ synchronizeTabs: true }).catch(function () {});
    var started = false;
    auth.onAuthStateChanged(function (u) {
      if (!u) { if (started) { location.reload(); return; } loginScreen(); return; }
      uid = u.uid; email = u.email || ""; hideGate();
      if (!started) { started = true; resolveDb(wrap()); var t = setInterval(function () { if (document.querySelector(".wrap")) { clearInterval(t); footer(); } }, 100); }
    });
  }
  window.claude = {
    use: function (n) {
      if (n === "db") return dbReady;
      if (n === "downloads") return Promise.resolve({ save: saveFile });
      return Promise.reject(new Error("unsupported: " + n));
    }
  };
  if ("serviceWorker" in navigator) window.addEventListener("load", function () { navigator.serviceWorker.register("sw.js").catch(function () {}); });
})();
