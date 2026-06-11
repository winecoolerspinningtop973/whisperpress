'use strict';
const { app, clipboard } = require('electron');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// Types text into whatever window has focus, via a persistent PowerShell
// helper using SendInput (no native node modules / compilers required).
const HELPER_PS1 = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class WPInput {
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] public struct InputUnion { [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public InputUnion U; }
  [DllImport("user32.dll", SetLastError=true)] public static extern uint SendInput(uint n, INPUT[] inputs, int size);
  static INPUT Mk(ushort vk, ushort scan, uint flags) { var i = new INPUT(); i.type = 1; i.U.ki.wVk = vk; i.U.ki.wScan = scan; i.U.ki.dwFlags = flags; return i; }
  public static void Key(ushort vk, bool up) { var a = new INPUT[]{ Mk(vk, 0, up ? 2u : 0u) }; SendInput(1, a, Marshal.SizeOf(typeof(INPUT))); }
  public static void Chr(ushort cu) { var a = new INPUT[]{ Mk(0, cu, 4u), Mk(0, cu, 6u) }; SendInput(2, a, Marshal.SizeOf(typeof(INPUT))); }
}
"@
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  # tolerate any leading garbage (e.g. a BOM mis-decoded by the console codepage)
  $typeIdx = $line.IndexOf('TYPE ')
  try {
    if ($line.Contains('PASTE')) {
      [WPInput]::Key(0x11, $false)   # Ctrl down
      Start-Sleep -Milliseconds 15
      [WPInput]::Key(0x56, $false)   # V down
      Start-Sleep -Milliseconds 15
      [WPInput]::Key(0x56, $true)
      [WPInput]::Key(0x11, $true)
      [Console]::Out.WriteLine('OK')
    } elseif ($typeIdx -ge 0) {
      $text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line.Substring($typeIdx + 5).Trim()))
      foreach ($ch in $text.ToCharArray()) {
        $cu = [uint16][char]$ch
        if ($cu -eq 13) { continue }
        if ($cu -eq 10) { [WPInput]::Key(0x0D, $false); [WPInput]::Key(0x0D, $true) }
        else { [WPInput]::Chr($cu) }
        Start-Sleep -Milliseconds 2
      }
      [Console]::Out.WriteLine('OK')
    } else {
      [Console]::Out.WriteLine('ERR unknown command')
    }
  } catch {
    [Console]::Out.WriteLine("ERR $($_.Exception.Message)")
  }
}
`;

class Injector {
  constructor() {
    this.proc = null;
    this.pending = [];
  }
  _ensure() {
    if (this.proc && !this.proc.killed && this.proc.exitCode === null) return;
    const dir = path.join(app.getPath('userData'), 'helpers');
    fs.mkdirSync(dir, { recursive: true });
    const script = path.join(dir, 'injector.ps1');
    fs.writeFileSync(script, '﻿' + HELPER_PS1, 'utf8'); // BOM so PS reads UTF-8
    this.proc = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
    ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '';
    this.proc.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        const p = this.pending.shift();
        if (p) (line.startsWith('OK') ? p.resolve() : p.reject(new Error(line)));
      }
    });
    this.proc.on('exit', () => {
      for (const p of this.pending.splice(0)) p.reject(new Error('injector exited'));
      this.proc = null;
    });
  }
  _send(cmd, timeoutMs) {
    this._ensure();
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject };
      const t = setTimeout(() => {
        const idx = this.pending.indexOf(entry);
        if (idx >= 0) this.pending.splice(idx, 1);
        reject(new Error('injector timeout'));
      }, timeoutMs);
      entry.resolve = () => { clearTimeout(t); resolve(); };
      entry.reject = (e) => { clearTimeout(t); reject(e); };
      this.pending.push(entry);
      this.proc.stdin.write(cmd + '\n');
    });
  }

  // mode: 'paste' | 'type'
  async inject(text, { mode = 'paste', restoreClipboard = true } = {}) {
    if (!text) return;
    if (mode === 'type') {
      const b64 = Buffer.from(text, 'utf8').toString('base64');
      await this._send(`TYPE ${b64}`, Math.max(15000, text.length * 8));
      return;
    }
    const prev = restoreClipboard ? clipboard.readText() : null;
    clipboard.writeText(text);
    await new Promise((r) => setTimeout(r, 80)); // let the clipboard settle
    await this._send('PASTE', 8000);
    if (restoreClipboard) {
      await new Promise((r) => setTimeout(r, 350)); // target app must read the clipboard first
      clipboard.writeText(prev || '');
    }
  }
  warmup() { try { this._ensure(); } catch (e) { console.error('injector warmup failed', e); } }
  kill() { if (this.proc) { try { this.proc.kill(); } catch { /* ignore */ } this.proc = null; } }
}

module.exports = new Injector();
