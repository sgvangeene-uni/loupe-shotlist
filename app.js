// Loupe Flow - the shotlist on the phone (step 8).
//
// A small app for Simon's phone, added to its home screen. It is linked to
// Loupe Flow once, with a code Loupe Flow shows, and then lists the
// shotlists that are online. A tick is kept on the phone first, with the
// phone's time and a number of its own, and sent whenever there is a
// connection: sent twice, the site keeps it once. Nothing is ever lost
// because the connection is: a tick waits until it is stored.
//
// Everything the site sends is shown as text, never as HTML.
"use strict";

(function () {
  var PREFIX = "loupe-shot-";
  var SEND_EVERY_MS = 20000;
  var REFRESH_AFTER_MS = 60000;
  var KEEP_SENT_DAYS = 30;
  var CONFIRM_AFTER_MS = 1500;

  // ---- what the phone keeps ----

  var storageWorks = true;

  function load(name, fallback) {
    try {
      var text = window.localStorage.getItem(PREFIX + name);
      return text === null ? fallback : JSON.parse(text);
    } catch (e) {
      storageWorks = false;
      return fallback;
    }
  }

  function keep(name, value) {
    try {
      window.localStorage.setItem(PREFIX + name, JSON.stringify(value));
      return true;
    } catch (e) {
      storageWorks = false;
      return false;
    }
  }

  function drop(name) {
    try {
      window.localStorage.removeItem(PREFIX + name);
    } catch (e) {
      storageWorks = false;
    }
  }

  var state = {
    site: load("site", ""),
    token: load("token", ""),
    phone: load("phone", null),
    lists: load("lists", []),
    fetchedAt: load("fetchedAt", 0),
    queue: load("queue", []),
    screen: "lists",
    listId: null,
    asking: null,
    unlinkAsked: false,
    sending: false,
    problem: null,           // "offline", "busy", "unlinked"
    retryAt: 0
  };

  // ---- small helpers ----

  function $(id) {
    return document.getElementById(id);
  }

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) {
      node.className = cls;
    }
    if (text !== undefined && text !== null) {
      node.textContent = String(text);
    }
    return node;
  }

  function newId() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return window.crypto.randomUUID();
    }
    var bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);
    return Array.prototype.map.call(bytes, function (b) { return (b + 256).toString(16).slice(1); }).join("");
  }

  function clock(ms) {
    var d = new Date(ms);
    return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  }

  function day(text) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(text || ""));
    return m ? m[3] + "-" + m[2] + "-" + m[1] : "";
  }

  function note(text, bad) {
    var n = $("note");
    n.textContent = text || "";
    n.className = "note" + (bad ? " bad" : "");
    n.hidden = !text;
  }

  function cleanSite(text) {
    var t = String(text || "").trim().replace(/\/+$/, "");
    if (!/^https?:\/\//i.test(t)) {
      t = "https://" + t;
    }
    try {
      var u = new URL(t);
      var local = u.hostname === "127.0.0.1" || u.hostname === "localhost";
      if (u.protocol !== "https:" && !(local && u.protocol === "http:")) {
        return "";
      }
      if (u.search || u.hash || u.username || u.password) {
        return "";
      }
      return u.origin + u.pathname.replace(/\/+$/, "");
    } catch (e) {
      return "";
    }
  }

  // ---- the site ----

  function NetError(text) {
    this.message = text;
  }

  function call(body) {
    // text/plain: a simple request, so a browser asks nothing first.
    return window.fetch(state.site + "/_functions/shot", {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=UTF-8" },
      body: JSON.stringify(body),
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer"
    }).then(function (res) {
      if (!res.ok) {
        throw new NetError("HTTP " + res.status);
      }
      return res.json();
    }, function () {
      throw new NetError("offline");
    });
  }

  function wait(seconds) {
    state.problem = "busy";
    state.retryAt = Date.now() + 1000 * Math.max(1, Number(seconds) || 30);
  }

  // "Not linked" only when a second call, a moment later, says so too: a
  // passing fault of the site never sends the photographer back to the desk.
  function refused(answer) {
    if (answer.error === "busy" || answer.error === "blocked") {
      wait(answer.retryAfter);
      return Promise.resolve();
    }
    if (answer.error !== "no_access") {
      return Promise.resolve();
    }
    var token = state.token;
    return new Promise(function (done) { window.setTimeout(done, CONFIRM_AFTER_MS); }).then(function () {
      return call({ action: "lists", token: token });
    }).then(function (again) {
      if (token !== state.token) {
        return;
      }
      if (again && again.ok === true) {
        wait(10);                 // linked after all: try again shortly
      } else if (again && again.error === "no_access") {
        state.problem = "unlinked";
      } else if (again) {
        wait(again.retryAfter);
      }
    }, function () {
      state.problem = "offline";
    });
  }

  // ---- ticks ----

  // Two windows of the app (Chrome and the installed app share what the
  // phone keeps) each add to the one queue: before writing, what the other
  // wrote is taken in, by id; sent or refused wins over waiting.
  var tidied = {};

  function mergeQueue(other) {
    var mine = {};
    state.queue.forEach(function (t) { mine[t.id] = t; });
    (Array.isArray(other) ? other : []).forEach(function (t) {
      if (!t || typeof t.id !== "string" || tidied[t.id]) {
        return;
      }
      var m = mine[t.id];
      if (!m) {
        state.queue.push(t);
        mine[t.id] = t;
      } else if (m.state === "waiting" && t.state !== "waiting") {
        m.state = t.state;
        m.why = t.why;
      }
    });
  }

  function saveQueue() {
    mergeQueue(load("queue", []));
    return keep("queue", state.queue);
  }

  function waiting() {
    return state.queue.filter(function (t) { return t.state === "waiting"; });
  }

  function notSent() {
    return state.queue.filter(function (t) { return t.state === "refused"; });
  }

  function sync() {
    if (state.sending || !state.token || state.problem === "unlinked" || Date.now() < state.retryAt) {
      return Promise.resolve();
    }
    var batch = waiting().slice(0, 100);
    if (!batch.length) {
      return Promise.resolve();
    }
    state.sending = true;
    showSync();
    return call({
      action: "ticks", token: state.token,
      events: batch.map(function (t) { return { id: t.id, list: t.list, item: t.item, on: t.on, at: t.at, tz: t.tz }; })
    }).then(function (answer) {
      if (!answer || answer.ok !== true) {
        return refused(answer || {});
      }
      state.problem = null;
      var moved = 0;
      var stored = {};
      (answer.stored || []).forEach(function (id) { stored[id] = true; });
      var why = {};
      (answer.rejected || []).forEach(function (r) { if (r && r.id) { why[r.id] = r.why || "refused"; } });
      state.queue.forEach(function (t) {
        if (t.state !== "waiting") {
          return;
        }
        if (stored[t.id]) {
          t.state = "sent";
          moved += 1;
        } else if (why[t.id] && why[t.id] !== "later") {
          t.state = "refused";
          t.why = why[t.id];
          moved += 1;
        }
      });
      saveQueue();
      if (!moved) {
        wait(10);                 // "later" for all of them: not again at once
      }
    }, function () {
      state.problem = "offline";
    }).then(function () {
      state.sending = false;
      render();
      if (!state.problem && waiting().length) {
        return sync();
      }
    });
  }

  function tick(list, item, on) {
    var t = {
      id: newId(), list: list.id, item: item.id, on: on, at: Date.now(),
      tz: -new Date().getTimezoneOffset(), state: "waiting"
    };
    state.queue.push(t);
    if (!saveQueue()) {
      note("This phone could not save the tick. Do not use a private window for this app.", true);
    }
    if (navigator.vibrate) {
      try { navigator.vibrate(12); } catch (e) { /* not on every phone */ }
    }
    render();
    sync();
  }

  // An item as it stands: the site's last word, or a later tick of this phone.
  function standing(list, itemId) {
    var best = null;
    var said = list.state && list.state[itemId];
    if (said && said.at) {
      best = { on: said.on === true, ms: Date.parse(said.at), id: "", state: "sent" };
    }
    state.queue.forEach(function (t) {
      if (t.list !== list.id || t.item !== itemId || t.state === "refused") {
        return;
      }
      if (!best || t.at > best.ms || (t.at === best.ms && t.id > best.id)) {
        best = { on: t.on, ms: t.at, id: t.id, state: t.state };
      }
    });
    return best;
  }

  // Ticks sent and of a list no longer here, after a while, go; a tick
  // waiting never does.
  function tidyQueue() {
    var here = {};
    state.lists.forEach(function (l) { here[l.id] = true; });
    var before = Date.now() - KEEP_SENT_DAYS * 86400000;
    var kept = state.queue.filter(function (t) {
      return t.state === "waiting" || here[t.list] || t.at > before;
    });
    if (kept.length !== state.queue.length) {
      state.queue.forEach(function (t) {
        if (kept.indexOf(t) < 0) {
          tidied[t.id] = true;
        }
      });
      state.queue = kept;
      saveQueue();
    }
  }

  // ---- lists ----

  function fetchLists(quiet, again) {
    if (!state.token || (state.problem === "unlinked" && !again)) {
      return Promise.resolve();
    }
    return call({ action: "lists", token: state.token }).then(function (answer) {
      if (!answer || answer.ok !== true) {
        return refused(answer || {});
      }
      if (state.problem !== "busy") {
        state.problem = null;
      }
      state.lists = Array.isArray(answer.lists) ? answer.lists : [];
      state.fetchedAt = Date.now();
      keep("lists", state.lists);
      keep("fetchedAt", state.fetchedAt);
      tidyQueue();
    }, function () {
      state.problem = "offline";
      if (!quiet) {
        note("No connection: these are the lists as they were last loaded.");
      }
    }).then(render);
  }

  function listById(id) {
    for (var i = 0; i < state.lists.length; i += 1) {
      if (state.lists[i].id === id) {
        return state.lists[i];
      }
    }
    return null;
  }

  function counts(list) {
    var on = 0;
    (list.items || []).forEach(function (item) {
      var s = standing(list, item.id);
      if (s && s.on) {
        on += 1;
      }
    });
    return { on: on, all: (list.items || []).length };
  }

  // ---- the screens ----

  function showSync() {
    var b = $("sync");
    var w = waiting().length;
    var r = notSent().length;
    b.className = "sync";
    if (!state.token) {
      b.textContent = "";
      return;
    }
    if (state.problem === "unlinked") {
      b.textContent = "Not linked";
      b.className = "sync bad";
    } else if (r) {
      b.textContent = r + " not sent";
      b.className = "sync bad";
    } else if (w) {
      b.textContent = w + " waiting" + (state.problem === "offline" ? " – no connection"
        : state.problem === "busy" ? " – busy" : state.sending ? " – sending" : "");
      b.className = "sync wait";
    } else {
      b.textContent = "All sent";
      b.className = "sync ok";
    }
  }

  function render() {
    showSync();
    var main = $("main");
    main.textContent = "";
    $("back").hidden = true;
    if (!storageWorks) {
      note("This phone does not keep what the app saves (a private window?). Ticks may be lost.", true);
    }
    if (!state.token) {
      $("title").textContent = "Link this phone";
      renderLink(main);
      return;
    }
    if (state.problem === "unlinked") {
      note("This phone is no longer linked to Loupe Flow. Link it again; ticks waiting to be sent are kept.", true);
    }
    var list = state.screen === "list" ? listById(state.listId) : null;
    if (list) {
      renderList(main, list);
    } else {
      state.screen = "lists";
      renderLists(main);
    }
  }

  function renderLink(main) {
    var form = el("form");
    form.noValidate = true;
    var standalone = window.navigator.standalone === true
      || (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches);
    if (/iPhone|iPad|iPod/.test(navigator.userAgent) && !standalone) {
      main.appendChild(el("p", "note", "On an iPhone: first add this page to your home screen "
        + "(Share → Add to Home Screen), then open it from there and link it."));
    }
    main.appendChild(el("p", "help", "In Loupe Flow: Settings → Online → Phones → Link a phone. "
      + "The code it shows can be used once, within 15 minutes."));
    var fields = [
      // Typed by hand, never filled in from a link: the code goes only to
      // the site Simon names himself.
      ["site", "Your site", "url", state.site],
      ["code", "Code", "text", ""],
      ["label", "Name of this phone", "text", (state.phone && state.phone.label) || ""]
    ];
    fields.forEach(function (f) {
      var label = el("label", null, f[1]);
      label.htmlFor = "f-" + f[0];
      var input = el("input", f[0] === "code" ? "code" : null);
      input.id = "f-" + f[0];
      input.type = f[2];
      input.value = f[3];
      input.autocomplete = "off";
      input.autocapitalize = f[0] === "code" ? "characters" : "off";
      input.spellcheck = false;
      if (f[0] === "code") {
        input.maxLength = 12;
        input.placeholder = "K7QM-3X9P";
      }
      if (f[0] === "label") {
        input.maxLength = 40;
        input.placeholder = "Simon's phone";
      }
      if (f[0] === "site") {
        input.placeholder = "https://www.example.nl";
      }
      form.appendChild(label);
      form.appendChild(input);
    });
    var go = el("button", "primary", "Link");
    go.type = "submit";
    go.id = "link";
    form.appendChild(go);
    form.addEventListener("submit", function (event) {
      event.preventDefault();
      var site = cleanSite($("f-site").value);
      if (!site) {
        note("That is not a valid site address (https://...).", true);
        return;
      }
      go.disabled = true;
      note("Linking...");
      state.site = site;
      call({ action: "pair", code: $("f-code").value, label: $("f-label").value }).then(function (answer) {
        if (answer && answer.ok === true && answer.token) {
          state.token = answer.token;
          state.phone = { phoneId: answer.phoneId, label: answer.label };
          state.problem = null;
          keep("site", state.site);
          keep("token", state.token);
          keep("phone", state.phone);
          note("Linked. The published shotlists are now being loaded.");
          return fetchLists(false).then(sync);
        }
        var e = answer && answer.error;
        note(e === "invalid" ? "That code is incorrect or no longer valid. Create a new one in Loupe Flow."
          : e === "blocked" ? "Too many incorrect codes. Create a new code in Loupe Flow and try again later."
            : e === "busy" ? "The site is busy. Please try again in a minute."
              : "That did not work. Please check the code.", true);
      }, function () {
        note("Cannot connect to that site. Check the address and your connection.", true);
      }).then(function () {
        go.disabled = false;
        if (!state.token) {
          render();
        }
      });
    });
    main.appendChild(form);
  }

  function renderLists(main) {
    $("title").textContent = "Shotlists";
    var top = el("div");
    var refresh = el("button", "link", "⟳ Refresh");
    refresh.type = "button";
    refresh.id = "refresh";
    refresh.addEventListener("click", function () {
      note("");
      state.retryAt = 0;
      if (state.problem !== "unlinked") {
        state.problem = null;
      }
      // Asks the site again, also when it said "not linked" before.
      fetchLists(false, true).then(sync);
    });
    top.appendChild(refresh);
    main.appendChild(top);
    if (!state.lists.length) {
      main.appendChild(el("p", "help", "No shotlists are published. Publish one in Loupe Flow, in the job's window."));
    }
    var ul = el("ul", "lists");
    state.lists.forEach(function (list) {
      var li = el("li");
      var b = el("button");
      b.type = "button";
      b.appendChild(el("span", null, list.title));
      var c = counts(list);
      b.appendChild(el("span", "meta", day(list.date) + " · " + c.on + " / " + c.all + " ticked"));
      b.addEventListener("click", function () {
        state.screen = "list";
        state.listId = list.id;
        state.asking = null;
        note("");
        render();
        window.scrollTo(0, 0);
      });
      li.appendChild(b);
      ul.appendChild(li);
    });
    main.appendChild(ul);
    var foot = el("p", "foot");
    foot.appendChild(document.createTextNode("This phone: " + ((state.phone && state.phone.label) || "linked") + " · "));
    var unlink = el("button", "link", state.unlinkAsked ? "Tap again to unlink" : "Unlink");
    unlink.type = "button";
    unlink.id = "unlink";
    unlink.addEventListener("click", function () {
      if (!state.unlinkAsked) {
        state.unlinkAsked = true;
        var w = waiting().length;
        if (w) {
          note(w + (w === 1 ? " tick waits" : " ticks wait") + " to be sent. They stay on this phone "
            + "and go once it is linked again.", true);
        }
        render();
        return;
      }
      state.unlinkAsked = false;
      state.token = "";
      state.phone = null;
      state.problem = null;
      drop("token");
      drop("phone");
      note("");
      render();
    });
    foot.appendChild(unlink);
    main.appendChild(foot);
  }

  function renderList(main, list) {
    $("title").textContent = list.title;
    $("back").hidden = false;
    var c = counts(list);
    main.appendChild(el("p", "progress", day(list.date) + " · " + c.on + " / " + c.all + " ticked"));
    var section = null;
    var ul = null;
    (list.items || []).forEach(function (item) {
      if (!ul || (item.section || "") !== section) {
        section = item.section || "";
        if (section) {
          main.appendChild(el("h2", "section", section));
        }
        ul = el("ul", "items");
        main.appendChild(ul);
      }
      var s = standing(list, item.id);
      var on = Boolean(s && s.on);
      var li = el("li");
      var b = el("button", "item" + (on ? " on" : ""));
      b.type = "button";
      b.dataset.item = item.id;
      b.appendChild(el("span", "box", on ? "✓" : ""));
      var text = el("span", "text");
      if (item.must) {
        text.appendChild(el("span", "must", "! "));
      }
      text.appendChild(document.createTextNode(item.text));
      var mine = state.queue.filter(function (t) { return t.list === list.id && t.item === item.id; });
      if (mine.some(function (t) { return t.state === "refused"; })) {
        text.appendChild(el("span", "state bad", "The site did not accept this tick."));
      } else if (s && s.state === "waiting") {
        text.appendChild(el("span", "state", "waiting to be sent"));
      }
      b.appendChild(text);
      b.appendChild(el("span", "when", on ? clock(s.ms) : ""));
      b.addEventListener("click", function () {
        if (on) {
          state.asking = state.asking === item.id ? null : item.id;
          render();
          return;
        }
        state.asking = null;
        tick(list, item, true);
      });
      li.appendChild(b);
      if (state.asking === item.id && on) {
        var ask = el("div", "ask");
        ask.appendChild(el("span", null, "Untick? Ticked at " + clock(s.ms) + "."));
        var yes = el("button", "danger", "Untick");
        yes.type = "button";
        yes.id = "untick";
        yes.addEventListener("click", function () {
          state.asking = null;
          tick(list, item, false);
        });
        var no = el("button", null, "Keep");
        no.type = "button";
        no.addEventListener("click", function () {
          state.asking = null;
          render();
        });
        ask.appendChild(yes);
        ask.appendChild(no);
        li.appendChild(ask);
      }
      ul.appendChild(li);
    });
  }

  // ---- start ----

  $("back").addEventListener("click", function () {
    state.screen = "lists";
    state.asking = null;
    note("");
    render();
  });
  $("sync").addEventListener("click", function () {
    var r = notSent();
    if (r.length) {
      note(r.length + (r.length === 1 ? " tick was" : " ticks were") + " not taken by the site: its list is no "
        + "longer online, or it was out of shape. Loupe Flow does not have " + (r.length === 1 ? "it." : "them."), true);
    } else if (waiting().length) {
      note("Ticks wait on this phone until there is a connection, and are then sent automatically.");
      state.retryAt = 0;
      sync();
    }
  });
  window.addEventListener("online", function () {
    state.retryAt = 0;
    if (state.problem === "offline") {
      state.problem = null;
    }
    sync().then(function () { return fetchLists(true); });
  });
  window.addEventListener("storage", function (event) {
    if (event.key === PREFIX + "queue") {
      mergeQueue(load("queue", []));
      render();
    } else if (event.key === PREFIX + "token") {
      state.site = load("site", "");
      state.token = load("token", "");
      state.phone = load("phone", null);
      state.problem = null;
      render();
    }
  });
  window.addEventListener("offline", function () {
    state.problem = "offline";
    showSync();
  });
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") {
      sync();
      if (Date.now() - state.fetchedAt > REFRESH_AFTER_MS) {
        fetchLists(true);
      }
    }
  });
  window.setInterval(function () {
    if (waiting().length) {
      sync();
    }
  }, SEND_EVERY_MS);

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(function () {
      note("This app could not set itself up to work without a connection here.", true);
    });
  }
  if (navigator.storage && navigator.storage.persist) {
    navigator.storage.persist().catch(function () { /* the phone decides */ });
  }

  render();
  if (state.token) {
    sync().then(function () { return fetchLists(true); });
  }
}());
