// Loupe Flow - the shotlist on the phone: keeps the app on the phone, so it
// opens without a connection. Only the app's own files are kept; the calls
// to the site (POST) always go to the site.
"use strict";

var CACHE = "loupe-shot-72ec52b0401c";
var FILES = ["./", "index.html", "app.js", "app.css", "manifest.webmanifest", "icon-192.png", "icon-512.png"];

self.addEventListener("install", function (event) {
  event.waitUntil(caches.open(CACHE).then(function (cache) {
    return cache.addAll(FILES);
  }).then(function () {
    return self.skipWaiting();
  }));
});

self.addEventListener("activate", function (event) {
  event.waitUntil(caches.keys().then(function (names) {
    return Promise.all(names.filter(function (n) {
      return n.indexOf("loupe-shot-") === 0 && n !== CACHE;
    }).map(function (n) {
      return caches.delete(n);
    }));
  }).then(function () {
    return self.clients.claim();
  }));
});

self.addEventListener("fetch", function (event) {
  var request = event.request;
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) {
    return;
  }
  event.respondWith(caches.open(CACHE).then(function (cache) {
    var key = request.mode === "navigate" ? "index.html" : request;
    return cache.match(key, { ignoreSearch: true }).then(function (kept) {
      return kept || fetch(request).then(function (res) {
        return res;
      }, function () {
        return cache.match("index.html");
      });
    });
  }));
});
