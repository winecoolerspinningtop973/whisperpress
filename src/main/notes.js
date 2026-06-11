'use strict';
const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

// One JSON file per note in userData/notes. Audio (optional) in userData/audio.
class Notes extends EventEmitter {
  constructor() {
    super();
    this.dir = path.join(app.getPath('userData'), 'notes');
    this.audioDir = path.join(app.getPath('userData'), 'audio');
    fs.mkdirSync(this.dir, { recursive: true });
    fs.mkdirSync(this.audioDir, { recursive: true });
  }
  _file(id) { return path.join(this.dir, `${id}.json`); }

  list() {
    const out = [];
    for (const f of fs.readdirSync(this.dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const n = JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8'));
        out.push(n);
      } catch { /* skip corrupt */ }
    }
    out.sort((a, b) => b.createdAt - a.createdAt);
    return out;
  }
  get(id) {
    try { return JSON.parse(fs.readFileSync(this._file(id), 'utf8')); } catch { return null; }
  }
  create(partial) {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const note = {
      id,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      title: '',
      text: '',
      segments: null, // [{t0,t1,text}] ms
      durationMs: 0,
      language: '',
      source: 'dictation', // 'dictation' | 'import' | 'meeting'
      audioFile: null,
      summary: '',
      ...partial,
    };
    fs.writeFileSync(this._file(id), JSON.stringify(note, null, 2));
    this.emit('changed');
    return note;
  }
  update(id, patch) {
    const note = this.get(id);
    if (!note) return null;
    const next = { ...note, ...patch, id, updatedAt: Date.now() };
    fs.writeFileSync(this._file(id), JSON.stringify(next, null, 2));
    this.emit('changed');
    return next;
  }
  remove(id) {
    const note = this.get(id);
    try { fs.unlinkSync(this._file(id)); } catch { /* ignore */ }
    if (note && note.audioFile) {
      try { fs.unlinkSync(path.join(this.audioDir, note.audioFile)); } catch { /* ignore */ }
    }
    this.emit('changed');
  }
  saveAudio(id, wavBuffer) {
    const name = `${id}.wav`;
    fs.writeFileSync(path.join(this.audioDir, name), wavBuffer);
    return name;
  }
  audioPath(note) {
    return note && note.audioFile ? path.join(this.audioDir, note.audioFile) : null;
  }
}

module.exports = new Notes();
