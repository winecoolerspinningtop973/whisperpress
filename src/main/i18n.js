'use strict';
const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const config = require('./config');

const LOCALE_DIR = path.join(__dirname, '..', 'common', 'locales');
const dicts = {};
for (const f of fs.readdirSync(LOCALE_DIR)) {
  if (f.endsWith('.json')) {
    dicts[path.basename(f, '.json')] = JSON.parse(fs.readFileSync(path.join(LOCALE_DIR, f), 'utf8'));
  }
}

function resolveLocale() {
  const pref = config.get().locale;
  if (pref && pref !== 'auto' && dicts[pref]) return pref;
  const sys = (app.getLocale() || 'en').toLowerCase();
  if (sys.startsWith('zh')) return 'zh-Hant';
  if (sys.startsWith('ja')) return 'ja';
  return 'en';
}

function t(key, vars) {
  const loc = resolveLocale();
  let s = (dicts[loc] && dicts[loc][key]) || (dicts.en && dicts.en[key]) || key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
}

function dict() {
  const loc = resolveLocale();
  return { locale: loc, strings: { ...dicts.en, ...(dicts[loc] || {}) } };
}

module.exports = { t, dict, resolveLocale };
