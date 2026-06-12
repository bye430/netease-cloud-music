const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  nativeImage,
  shell,
  globalShortcut,
  ipcMain,
} = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

if (process.platform === 'linux') {
  app.commandLine.appendSwitch('no-sandbox');
  app.commandLine.appendSwitch('class', 'netease-cloud-music');
}

const HOME_URL = 'https://music.163.com/st/webplayer';
const PARTITION = 'persist:netease-music';
const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const STATE_FILE = path.join(app.getPath('userData'), 'window-state.json');
const LYRICS_STATE_FILE = path.join(app.getPath('userData'), 'lyrics-window-state.json');
const LYRICS_SETTINGS_FILE = path.join(app.getPath('userData'), 'lyrics-settings.json');
const LYRICS_FONTS_FILE = path.join(__dirname, 'assets', 'fonts', 'fonts.json');

const DEFAULT_LYRICS_SETTINGS = {
  fontId: 'noto-sans-sc',
  currentColor: '#ff6b81',
  nextColor: 'rgba(255, 255, 255, 0.45)',
  opacity: 0.82,
};
const SHORTCUTS_CONFIG_FILE = path.join(app.getPath('userData'), 'shortcuts-config.json');
const APP_PATH_CONF = path.join(app.getPath('userData'), 'app-path.conf');

const DEFAULT_SHORTCUTS = {
  playPause: 'XF86AudioPlay',
  next: 'XF86AudioNext',
  prev: 'XF86AudioPrev',
};

let mainWindow = null;
let shortcutsWindow = null;
let lyricsWindow = null;
let tray = null;
let isQuitting = false;
let lyricsVisible = false;
let lyricsPinned = true;
let lyricsPollTimer = null;
let lyricsSettingsOpen = false;
let lyricsBaseHeight = null;
let lyricsBoundsAnimationTimer = null;
let lyricsBoundsAnimating = false;

const LYRICS_SETTINGS_ANIM_MS = 300;

function stopLyricsBoundsAnimation() {
  if (lyricsBoundsAnimationTimer) {
    clearTimeout(lyricsBoundsAnimationTimer);
    lyricsBoundsAnimationTimer = null;
  }
}

function easeOutCubic(t) {
  return 1 - (1 - t) ** 3;
}

function animateLyricsWindowBounds(targetBounds, duration = LYRICS_SETTINGS_ANIM_MS) {
  return new Promise((resolve) => {
    if (!lyricsWindow || lyricsWindow.isDestroyed()) {
      resolve();
      return;
    }

    stopLyricsBoundsAnimation();
    lyricsBoundsAnimating = true;

    const start = lyricsWindow.getBounds();
    const startTime = Date.now();

    const tick = () => {
      if (!lyricsWindow || lyricsWindow.isDestroyed()) {
        stopLyricsBoundsAnimation();
        lyricsBoundsAnimating = false;
        resolve();
        return;
      }

      const elapsed = Date.now() - startTime;
      const progress = Math.min(1, elapsed / duration);
      const eased = easeOutCubic(progress);

      lyricsWindow.setBounds({
        x: Math.round(start.x + (targetBounds.x - start.x) * eased),
        y: Math.round(start.y + (targetBounds.y - start.y) * eased),
        width: targetBounds.width,
        height: Math.round(start.height + (targetBounds.height - start.height) * eased),
      });

      if (progress >= 1) {
        lyricsWindow.setBounds(targetBounds);
        stopLyricsBoundsAnimation();
        lyricsBoundsAnimating = false;
        resolve();
        return;
      }

      lyricsBoundsAnimationTimer = setTimeout(tick, 16);
    };

    tick();
  });
}

function loadWindowState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return { width: 1200, height: 800, x: undefined, y: undefined, isMaximized: false };
  }
}

function saveWindowState() {
  if (!mainWindow) return;
  const bounds = mainWindow.getBounds();
  const state = {
    ...bounds,
    isMaximized: mainWindow.isMaximized(),
  };
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function loadLyricsWindowState() {
  try {
    const raw = fs.readFileSync(LYRICS_STATE_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return { width: 520, height: 160, x: undefined, y: undefined };
  }
}

function saveLyricsWindowState() {
  if (!lyricsWindow || lyricsBoundsAnimating) return;
  const bounds = lyricsWindow.getBounds();
  const saved = {
    ...bounds,
    height:
      lyricsSettingsOpen && lyricsBaseHeight !== null ? lyricsBaseHeight : bounds.height,
  };
  fs.writeFileSync(LYRICS_STATE_FILE, JSON.stringify(saved, null, 2));
}

function loadLyricsSettings() {
  try {
    const raw = fs.readFileSync(LYRICS_SETTINGS_FILE, 'utf8');
    return { ...DEFAULT_LYRICS_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_LYRICS_SETTINGS };
  }
}

function saveLyricsSettings(settings) {
  const merged = { ...DEFAULT_LYRICS_SETTINGS, ...settings };
  fs.writeFileSync(LYRICS_SETTINGS_FILE, JSON.stringify(merged, null, 2));
  sendLyricsSettings(merged);
  return merged;
}

function loadLyricsFontList() {
  try {
    const raw = fs.readFileSync(LYRICS_FONTS_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function sendLyricsSettings(settings) {
  if (lyricsWindow && !lyricsWindow.isDestroyed()) {
    lyricsWindow.webContents.send('lyrics-settings-update', settings);
  }
}

function ensureScriptPermissions() {
  for (const name of [
    'netease-music-ctl.sh',
    'apply-shortcuts.sh',
    'install-system-shortcuts.sh',
    'uninstall-system-shortcuts.sh',
  ]) {
    const scriptPath = path.join(__dirname, 'scripts', name);
    try {
      fs.chmodSync(scriptPath, 0o755);
    } catch {
      // ignore
    }
  }
}

function writeAppPathConf() {
  try {
    fs.writeFileSync(APP_PATH_CONF, `APP_DIR=${__dirname}\n`, 'utf8');
  } catch {
    // ignore
  }
}

function parseControlArg(argv) {
  const arg = argv.find((item) => item.startsWith('--control='));
  return arg ? arg.slice('--control='.length) : null;
}

function loadShortcutsConfig() {
  try {
    const raw = fs.readFileSync(SHORTCUTS_CONFIG_FILE, 'utf8');
    return { ...DEFAULT_SHORTCUTS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_SHORTCUTS };
  }
}

function saveShortcutsConfig(config) {
  fs.writeFileSync(SHORTCUTS_CONFIG_FILE, JSON.stringify(config, null, 2));
}

function applyShortcutsConfig(config) {
  return new Promise((resolve) => {
    saveShortcutsConfig(config);
    const scriptPath = path.join(__dirname, 'scripts', 'apply-shortcuts.sh');
    const child = spawn('bash', [scriptPath, SHORTCUTS_CONFIG_FILE], {
      env: { ...process.env, DISPLAY: process.env.DISPLAY, XDG_CURRENT_DESKTOP: process.env.XDG_CURRENT_DESKTOP },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (code) => {
      resolve({
        ok: code === 0,
        message: code === 0 ? stdout.trim() || '系统快捷键已应用' : stderr.trim() || stdout.trim() || `退出码 ${code}`,
      });
    });
  });
}

function runPrivilegedScript(scriptName, args = []) {
  return new Promise((resolve) => {
    const scriptPath = path.join(__dirname, 'scripts', scriptName);
    const run = (command, commandArgs) => {
      const child = spawn(command, commandArgs, { env: process.env });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      child.on('error', (error) => {
        resolve({ ok: false, message: error.message });
      });
      child.on('close', (code) => {
        resolve({
          ok: code === 0,
          message: code === 0 ? stdout.trim() || '完成' : stderr.trim() || stdout.trim() || `退出码 ${code}`,
        });
      });
    };

    run('pkexec', ['bash', scriptPath, ...args]);
  });
}

function systemCtlInstalled() {
  return fs.existsSync('/usr/local/bin/netease-music-ctl');
}

function createTrayIcon() {
  const iconPath = path.join(__dirname, 'assets', 'tray.png');
  if (fs.existsSync(iconPath)) {
    return nativeImage.createFromPath(iconPath);
  }
  return nativeImage.createEmpty();
}

const WEBPACK_HOOK_SCRIPT = `
(() => {
  if (window.__neteaseWebpackHooked) return;
  window.__neteaseWebpackHooked = true;

  function tryCapture(modules) {
    if (!modules || window.__neteaseReduxDispatch) return;

    const installed = {};
    function __webpack_require__(moduleId) {
      if (installed[moduleId]) return installed[moduleId].exports;
      if (!modules[moduleId]) return {};
      const module = (installed[moduleId] = { exports: {} });
      try {
        modules[moduleId](module, module.exports, __webpack_require__);
      } catch {}
      return module.exports;
    }

    for (const moduleId of Object.keys(modules)) {
      try {
        const exp = __webpack_require__(moduleId);
        for (const val of [exp, exp?.a, exp?.default]) {
          if (!val?.getDispatch) continue;
          try {
            const dispatch = val.getDispatch();
            if (typeof dispatch === 'function') {
              window.__neteaseReduxDispatch = dispatch;
              return;
            }
          } catch {}
        }
      } catch {}
    }
  }

  const queue = (window.webpackJsonp = window.webpackJsonp || []);
  const originalPush = queue.push.bind(queue);
  queue.push = function (...args) {
    const result = originalPush(...args);
    for (const chunk of args) tryCapture(chunk?.[1]);
    return result;
  };

  for (const chunk of queue) tryCapture(chunk?.[1]);
})();
`;

const PLAYBACK_HELPER_SCRIPT = `
(() => {
  const HELPER_VERSION = 20;
  if (window.__neteaseDesktop?.playbackVersion === HELPER_VERSION) return;
  window.__neteaseDesktop = window.__neteaseDesktop || {};
  window.__neteaseDesktop.playbackVersion = HELPER_VERSION;

  ${WEBPACK_HOOK_SCRIPT.replace(/^/gm, '').trim()}

  const nativePlay = HTMLAudioElement.prototype.__neteaseNativePlay
    || HTMLAudioElement.prototype.play;
  if (!HTMLAudioElement.prototype.__neteaseNativePlay) {
    HTMLAudioElement.prototype.__neteaseNativePlay = nativePlay;
  }

  const state = {
    activeAudio: null,
    lastSrc: '',
    savedTime: 0,
    userPaused: false,
    resuming: false,
  };

  function getLyricsStore() {
    const root = window.top || window;
    if (!root.__neteaseLyricsStore) {
      root.__neteaseLyricsStore = {
        playbackMeta: { songId: null, title: '', artist: '' },
        songDetailCache: { id: null, title: '', artist: '' },
        lyricCache: { songId: null, lines: [] },
      };
    }
    return root.__neteaseLyricsStore;
  }

  function installPlaybackMetaHook() {
    if (window.__neteasePlaybackMetaHooked) return;
    window.__neteasePlaybackMetaHooked = true;

    function recordPlayerUrl(json) {
      const store = getLyricsStore();
      const list = json?.data || json?.songs || [];
      if (!Array.isArray(list)) return;
      for (const item of list) {
        const id = item?.id ?? item?.songId;
        if (!id) continue;
        const songId = String(id);
        if (store.playbackMeta.songId !== songId) {
          store.playbackMeta.title = '';
          store.playbackMeta.artist = '';
          store.songDetailCache.id = null;
          store.songDetailCache.title = '';
          store.songDetailCache.artist = '';
          store.lyricCache.songId = null;
          store.lyricCache.lines = [];
        }
        store.playbackMeta.songId = songId;
        if (item?.name) store.playbackMeta.title = item.name;
        if (item?.ar?.map) {
          store.playbackMeta.artist = item.ar.map((a) => a.name).join(' / ');
        }
      }
    }

    function watchUrl(url, getJson) {
      if (!url || !url.includes('song/enhance/player/url')) return;
      Promise.resolve()
        .then(getJson)
        .then(recordPlayerUrl)
        .catch(() => {});
    }

    const origFetch = window.fetch;
    window.fetch = function (...args) {
      const result = origFetch.apply(this, args);
      try {
        const input = args[0];
        const url = typeof input === 'string' ? input : input?.url || '';
        watchUrl(url, () => result.then((res) => res.clone().json()));
      } catch {}
      return result;
    };

    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      this.__neteaseUrl = url;
      return origOpen.call(this, method, url, ...rest);
    };
    XMLHttpRequest.prototype.send = function (...args) {
      this.addEventListener('load', () => {
        try {
          watchUrl(this.__neteaseUrl, () => JSON.parse(this.responseText));
        } catch {}
      });
      return origSend.apply(this, args);
    };
  }

  installPlaybackMetaHook();

  function eachWindow(fn) {
    const wins = [window];
    try {
      if (window.parent && window.parent !== window) wins.push(window.parent);
    } catch {}
    try {
      if (window.top) wins.push(window.top);
    } catch {}
    try {
      const iframe = document.getElementById('g_iframe');
      if (iframe?.contentWindow) wins.push(iframe.contentWindow);
    } catch {}

    const seen = new Set();
    for (const w of wins) {
      if (!w || seen.has(w)) continue;
      seen.add(w);
      fn(w);
    }
  }

  function eachPlayerDocument(fn) {
    const docs = new Set();
    eachWindow((w) => {
      if (w.document) docs.add(w.document);
    });
    for (const doc of docs) fn(doc);
  }

  function clickInDocuments(selectors) {
    let clicked = false;
    eachPlayerDocument((doc) => {
      if (clicked) return;
      for (const sel of selectors) {
        const el = doc.querySelector(sel);
        if (el) {
          el.click();
          clicked = true;
          return;
        }
      }
    });
    return clicked;
  }

  function clickPlayerButton(direction) {
    const selectors =
      direction === 'next'
        ? ['.m-playbar .nxt', '.m-playbar a.nxt', 'a.nxt', '[title="下一首"]', '.btns .nxt']
        : ['.m-playbar .prv', '.m-playbar a.prv', 'a.prv', '[title="上一首"]', '.btns .prv'];
    return clickInDocuments(selectors);
  }

  function isVisible(el) {
    if (!el) return false;
    const view = el.ownerDocument?.defaultView;
    if (!view) return false;
    const style = view.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    return el.offsetWidth > 0 || el.offsetHeight > 0;
  }

  function clickPlayPauseButton() {
    let clicked = false;
    eachPlayerDocument((doc) => {
      if (clicked) return;
      for (const el of doc.querySelectorAll(
        'a[title*="播放/暂停"], .m-playbar a.ply, .m-playbar a.pas'
      )) {
        if (!isVisible(el)) continue;
        el.click();
        clicked = true;
        return;
      }
    });
    return clicked;
  }

  function eachAudio(fn) {
    eachWindow((w) => {
      for (const audio of w.document.querySelectorAll('audio')) fn(audio);
    });
  }

  function getAnyActiveAudio() {
    if (state.activeAudio) return state.activeAudio;

    let found = null;
    eachWindow((w) => {
      if (found) return;
      const audio = w.__neteaseDesktop?.playback?.activeAudio;
      if (audio) found = audio;
    });
    return found;
  }

  function bindActiveAudio(audio) {
    if (!audio || audio.__neteaseDesktopBound) return;
    audio.__neteaseDesktopBound = true;

    audio.addEventListener('timeupdate', () => {
      if (audio !== state.activeAudio || audio.paused || state.userPaused) return;
      state.savedTime = audio.currentTime;
    });

    audio.addEventListener('seeked', () => {
      if (audio !== state.activeAudio) return;
      state.savedTime = audio.currentTime;
    });

    audio.addEventListener('pause', () => {
      if (audio !== state.activeAudio || state.resuming) return;
      state.savedTime = audio.currentTime;
      if (!audio.ended) state.userPaused = true;
    });

    audio.addEventListener('play', () => {
      if (audio !== state.activeAudio) return;
      state.userPaused = false;
    });
  }

  function trackActiveAudio(audio) {
    const src = audio?.currentSrc || audio?.src || '';
    if (src && src !== state.lastSrc) {
      state.lastSrc = src;
      state.savedTime = 0;
      state.userPaused = false;
      const store = getLyricsStore();
      store.lyricCache.songId = null;
      store.lyricCache.lines = [];
    }
    state.activeAudio = audio;
    bindActiveAudio(audio);
  }

  function pauseOtherAudios(keep) {
    eachAudio((audio) => {
      if (audio === keep || audio.paused) return;
      try {
        audio.pause();
      } catch {}
    });
  }

  function resetPlaybackTracking() {
    state.activeAudio = null;
    state.lastSrc = '';
    state.savedTime = 0;
    state.userPaused = false;
    state.resuming = false;
    const store = getLyricsStore();
    store.lyricCache.songId = null;
    store.lyricCache.lines = [];
    store.playbackMeta.songId = null;
    store.playbackMeta.title = '';
    store.playbackMeta.artist = '';
    store.songDetailCache.id = null;
    store.songDetailCache.title = '';
    store.songDetailCache.artist = '';
  }

  function getReduxDispatch() {
    if (typeof window.__neteaseReduxDispatch === 'function') {
      return window.__neteaseReduxDispatch;
    }
    return null;
  }

  function reduxDispatch(action) {
    const dispatch = getReduxDispatch();
    if (!dispatch) return false;

    try {
      dispatch(action);
    } catch {
      return false;
    }
    return true;
  }

  function dispatchJumpTrack(flag) {
    return reduxDispatch({
      type: 'playing/jump2Track',
      payload: { flag, type: 'call', triggerScene: 'hotKey' },
    });
  }

  function dispatchHandleHotkey(name) {
    return reduxDispatch({
      type: 'handleHotkey',
      payload: {
        name,
        global: true,
        event: { keyCode: name.includes('next') ? 176 : 177 },
      },
    });
  }

  if (!HTMLAudioElement.prototype.__neteasePlayHooked) {
    HTMLAudioElement.prototype.__neteasePlayHooked = true;
    HTMLAudioElement.prototype.play = function (...args) {
      if (state.userPaused && this !== state.activeAudio && !state.resuming) {
        return Promise.resolve();
      }
      trackActiveAudio(this);
      return nativePlay.apply(this, args);
    };
  }

  function resumeActiveAudio() {
    const audio = state.activeAudio || getAnyActiveAudio();
    if (!audio) return false;

    const time = state.savedTime > 0 ? state.savedTime : audio.currentTime;
    state.userPaused = false;
    state.resuming = true;
    state.activeAudio = audio;
    pauseOtherAudios(audio);

    const doResume = () => {
      if (time > 0 && Number.isFinite(time)) {
        try {
          const duration = audio.duration;
          audio.currentTime =
            Number.isFinite(duration) && duration > 0
              ? Math.min(time, duration)
              : time;
        } catch {}
      }
      return nativePlay.call(audio).finally(() => {
        state.resuming = false;
      });
    };

    if (audio.readyState >= 1) {
      doResume();
      return true;
    }

    const onReady = () => doResume();
    audio.addEventListener('loadedmetadata', onReady, { once: true });
    audio.addEventListener('canplay', onReady, { once: true });
    return true;
  }

  function togglePlayback() {
    const audio = state.activeAudio || getAnyActiveAudio();

    if (audio && !audio.paused && !audio.ended) {
      state.savedTime = audio.currentTime;
      state.userPaused = true;
      state.activeAudio = audio;
      audio.pause();
      return;
    }

    if (audio && (audio.paused || audio.ended || state.userPaused)) {
      if (resumeActiveAudio()) return;
    }

    clickPlayPauseButton();
  }

  function skipTrack(direction) {
    resetPlaybackTracking();

    if (direction === 'prev') {
      if (dispatchJumpTrack(-1)) return;
      if (dispatchHandleHotkey('prev_1')) return;
      clickPlayerButton('prev');
      return;
    }

    if (dispatchJumpTrack(1)) return;
    if (dispatchHandleHotkey('next_1')) return;
    clickPlayerButton('next');
  }

  function parseLrc(text) {
    const lines = [];
    if (!text) return lines;
    for (const raw of text.split('\\n')) {
      const tags = raw.match(/\\[(\\d+):(\\d+(?:\\.\\d+)?)\\]/g);
      if (!tags) continue;
      const content = raw.replace(/\\[\\d+:\\d+(?:\\.\\d+)?\\]/g, '').trim();
      if (!content) continue;
      for (const tag of tags) {
        const matched = tag.match(/\\[(\\d+):(\\d+(?:\\.\\d+)?)\\]/);
        if (!matched) continue;
        const time = Number(matched[1]) * 60 + Number(matched[2]);
        lines.push({ time, content });
      }
    }
    lines.sort((a, b) => a.time - b.time);
    return lines;
  }

  function pickLyricLines(lines, currentTime) {
    let current = '';
    let next = '';
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i].time <= currentTime) {
        current = lines[i].content;
        next = lines[i + 1]?.content || '';
      } else {
        break;
      }
    }
    return { current, next };
  }

  function extractSongId(href) {
    if (!href) return null;
    const matched =
      String(href).match(/[?&]id=(\\d+)/) ||
      String(href).match(/song\\/(\\d+)/) ||
      String(href).match(/#\\/song\\?id=(\\d+)/);
    return matched ? matched[1] : null;
  }

  function getPlaybarInfo() {
    const store = getLyricsStore();
    const playbackMeta = store.playbackMeta;
    let info = { title: '', artist: '', songId: null };

    eachPlayerDocument((doc) => {
      const root = doc.querySelector('#g_player') || doc.querySelector('.m-playbar');
      if (!root) return;

      const songLink = root.querySelector(
        'a[href*="/song?id="], a[href*="song?id="], a[href*="#/song?id="]'
      );
      const nameLink =
        root.querySelector('.first .name a, .name a, .song a, .play .name a') || songLink;
      const artistLink = root.querySelector('.by a, .artist a, .singer a');

      const title =
        nameLink?.textContent?.trim() ||
        root.querySelector('.first .name, .name, .song-name, .play .name')?.textContent?.trim() ||
        root.querySelector('.head')?.getAttribute('title')?.trim() ||
        '';
      const artist =
        artistLink?.textContent?.trim() ||
        root.querySelector('.by, .artist, .singer')?.textContent?.trim() ||
        '';

      let songId =
        extractSongId(nameLink?.getAttribute('href')) ||
        extractSongId(songLink?.getAttribute('href'));

      if (!songId) {
        const resid = root.querySelector('[data-resid]')?.getAttribute('data-resid');
        if (resid && /^\\d+$/.test(resid)) songId = resid;
      }

      if (songId || title || artist) {
        info = {
          title: title || info.title,
          artist: artist || info.artist,
          songId: songId || info.songId,
        };
      }
    });

    if (playbackMeta.songId) {
      info.songId = info.songId || playbackMeta.songId;
      const sameSong = !info.songId || info.songId === playbackMeta.songId;
      if (sameSong) {
        if (!info.title) info.title = playbackMeta.title;
        if (!info.artist) info.artist = playbackMeta.artist;
      }
    }

    return info;
  }

  async function ensureSongMeta(info) {
    if (!info.songId) return info;

    const store = getLyricsStore();
    const songDetailCache = store.songDetailCache;
    const playbackMeta = store.playbackMeta;

    if (songDetailCache.id === info.songId && songDetailCache.title) {
      return {
        ...info,
        title: songDetailCache.title,
        artist: songDetailCache.artist || info.artist,
      };
    }

    const response = await fetch(
      'https://music.163.com/api/song/detail/?ids=[' + info.songId + ']',
      { credentials: 'include' }
    );
    const json = await response.json();
    const song = json?.songs?.[0];
    if (song) {
      songDetailCache.id = info.songId;
      songDetailCache.title = song.name || '';
      songDetailCache.artist = (song.ar || []).map((a) => a.name).join(' / ');
      playbackMeta.songId = info.songId;
      playbackMeta.title = songDetailCache.title;
      playbackMeta.artist = songDetailCache.artist;
    }

    return {
      ...info,
      title: songDetailCache.title || info.title,
      artist: songDetailCache.artist || info.artist,
    };
  }

  async function fetchLyricLines(songId) {
    const store = getLyricsStore();
    const lyricCache = store.lyricCache;
    const id = String(songId);
    if (lyricCache.songId === id) return lyricCache.lines;

    const response = await fetch(
      'https://music.163.com/api/song/lyric?id=' + id + '&lv=1&kv=1&tv=-1',
      { credentials: 'include' }
    );
    const json = await response.json();
    const lines = parseLrc(json?.lrc?.lyric || '');
    lyricCache.songId = id;
    lyricCache.lines = lines;
    return lines;
  }

  async function getLyricsSnapshot() {
    let info = getPlaybarInfo();
    const audio = getAnyActiveAudio();
    const currentTime = audio?.currentTime || 0;
    const paused = !audio || audio.paused;

    if (!info.songId && !info.title) {
      return {
        title: '',
        artist: '',
        currentLine: '',
        nextLine: '',
        paused,
        currentTime,
      };
    }

    try {
      info = await ensureSongMeta(info);
    } catch {
      // ignore
    }

    if (!info.songId) {
      const wordsLine = (() => {
        let line = '';
        eachPlayerDocument((doc) => {
          if (line) return;
          const words = doc.querySelector('#g_player .words, .m-playbar .words, .play .words');
          const text = words?.textContent?.trim();
          if (text) line = text.split('\\n')[0];
        });
        return line;
      })();

      return {
        title: info.title,
        artist: info.artist,
        currentLine: wordsLine,
        nextLine: '',
        paused,
        currentTime,
      };
    }

    try {
      const lines = await fetchLyricLines(info.songId);
      const picked = pickLyricLines(lines, currentTime);
      return {
        songId: info.songId,
        title: info.title,
        artist: info.artist,
        currentLine: picked.current,
        nextLine: picked.next,
        paused,
        currentTime,
      };
    } catch {
      return {
        songId: info.songId,
        title: info.title,
        artist: info.artist,
        currentLine: '',
        nextLine: '',
        paused,
        currentTime,
      };
    }
  }

  window.__neteaseDesktop.playback = state;
  window.__neteaseDesktop.togglePlayback = togglePlayback;
  window.__neteaseDesktop.skipTrack = skipTrack;
  window.__neteaseDesktop.getLyricsSnapshot = getLyricsSnapshot;
})();
`;

function forEachFrame(callback) {
  if (!mainWindow) return;
  const visited = new Set();
  const walk = (frame) => {
    if (!frame || visited.has(frame)) return;
    visited.add(frame);
    callback(frame);
    for (const child of frame.frames || []) walk(child);
  };
  walk(mainWindow.webContents.mainFrame);
}

function injectPlaybackHelper() {
  forEachFrame((frame) => {
    frame.executeJavaScript(PLAYBACK_HELPER_SCRIPT).catch(() => {});
  });
}

const RUN_IN_PLAYER_CONTEXT = `
(() => {
  const wins = [window];
  try {
    const iframe = document.getElementById('g_iframe');
    if (iframe?.contentWindow) wins.push(iframe.contentWindow);
  } catch {}

  for (const w of wins) {
    if (w.__neteaseDesktop?.playback?.activeAudio) return w;
  }
  for (const w of wins) {
    if (w.__neteaseDesktop) return w;
  }
  return window;
})()
`;

function runInPlayerContext(expression) {
  if (!mainWindow) return Promise.resolve();
  injectPlaybackHelper();
  return mainWindow.webContents.executeJavaScript(`
    (() => {
      const ctx = ${RUN_IN_PLAYER_CONTEXT};
      return ctx.__neteaseDesktop?.${expression};
    })()
  `);
}

function togglePlayback() {
  runInPlayerContext('togglePlayback?.()').catch(() => {});
}

function skipTrack(direction) {
  runInPlayerContext(`skipTrack?.('${direction}')`).catch(() => {});
}

function handleControlCommand(command) {
  switch (command) {
    case 'play-pause':
      togglePlayback();
      break;
    case 'next':
      skipTrack('next');
      break;
    case 'prev':
      skipTrack('prev');
      break;
    case 'show':
      mainWindow?.show();
      mainWindow?.focus();
      break;
    default:
      break;
  }
}

function openShortcutsWindow() {
  if (shortcutsWindow) {
    shortcutsWindow.show();
    shortcutsWindow.focus();
    return;
  }

  shortcutsWindow = new BrowserWindow({
    width: 520,
    height: 460,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: '快捷键设置',
    parent: mainWindow ?? undefined,
    modal: false,
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'shortcuts-preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  shortcutsWindow.loadFile(path.join(__dirname, 'shortcuts.html'));
  shortcutsWindow.on('closed', () => {
    shortcutsWindow = null;
  });
}

function stopLyricsPolling() {
  if (lyricsPollTimer) {
    clearInterval(lyricsPollTimer);
    lyricsPollTimer = null;
  }
}

async function pollLyrics() {
  if (!mainWindow || !lyricsWindow || !lyricsVisible) return;

  const data = await mainWindow.webContents
    .executeJavaScript(`
      (async () => {
        const wins = [window];
        try {
          const iframe = document.getElementById('g_iframe');
          if (iframe?.contentWindow) wins.push(iframe.contentWindow);
        } catch {}

        let last = null;
        for (const w of wins) {
          if (!w.__neteaseDesktop?.getLyricsSnapshot) continue;
          const snap = await w.__neteaseDesktop.getLyricsSnapshot();
          if (snap) last = snap;
          if (snap?.songId || snap?.title) return snap;
        }
        return last;
      })()
    `)
    .catch(() => null);

  if (data && lyricsWindow && !lyricsWindow.isDestroyed()) {
    lyricsWindow.webContents.send('lyrics-update', data);
  }
}

function startLyricsPolling() {
  stopLyricsPolling();
  pollLyrics();
  lyricsPollTimer = setInterval(pollLyrics, 400);
}

function collapseLyricsSettingsPanel() {
  if (!lyricsWindow || lyricsWindow.isDestroyed() || !lyricsSettingsOpen) return;
  stopLyricsBoundsAnimation();
  const bounds = lyricsWindow.getBounds();
  if (lyricsBaseHeight !== null) {
    const extra = bounds.height - lyricsBaseHeight;
    lyricsWindow.setBounds({
      x: bounds.x,
      y: bounds.y + extra,
      width: bounds.width,
      height: lyricsBaseHeight,
    });
  }
  lyricsSettingsOpen = false;
  lyricsBaseHeight = null;
  lyricsWindow.webContents.send('lyrics-settings-panel-close');
}

function hideLyricsWindow() {
  lyricsVisible = false;
  stopLyricsPolling();
  if (lyricsWindow) {
    collapseLyricsSettingsPanel();
    saveLyricsWindowState();
    lyricsWindow.hide();
  }
  buildMenu();
}

function quitApp() {
  if (isQuitting) return;
  isQuitting = true;

  stopLyricsPolling();
  globalShortcut.unregisterAll();
  saveWindowState();
  saveLyricsWindowState();

  if (shortcutsWindow && !shortcutsWindow.isDestroyed()) {
    shortcutsWindow.destroy();
    shortcutsWindow = null;
  }
  if (lyricsWindow && !lyricsWindow.isDestroyed()) {
    lyricsWindow.destroy();
    lyricsWindow = null;
  }
  if (tray) {
    tray.destroy();
    tray = null;
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.destroy();
    mainWindow = null;
  }

  app.quit();
}

function showLyricsWindow() {
  if (!mainWindow) return;

  if (lyricsWindow) {
    lyricsVisible = true;
    lyricsWindow.show();
    sendLyricsPinState();
    sendLyricsSettings(loadLyricsSettings());
    startLyricsPolling();
    buildMenu();
    return;
  }

  const state = loadLyricsWindowState();
  lyricsWindow = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    minWidth: 360,
    minHeight: 100,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: lyricsPinned,
    skipTaskbar: true,
    resizable: true,
    hasShadow: false,
    show: false,
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'lyrics-preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  lyricsWindow.loadFile(path.join(__dirname, 'lyrics.html'));
  lyricsWindow.once('ready-to-show', () => {
    lyricsVisible = true;
    lyricsWindow.show();
    sendLyricsPinState();
    sendLyricsSettings(loadLyricsSettings());
    startLyricsPolling();
    buildMenu();
  });

  lyricsWindow.on('move', saveLyricsWindowState);
  lyricsWindow.on('resize', saveLyricsWindowState);
  lyricsWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      hideLyricsWindow();
    }
  });

  lyricsWindow.on('closed', () => {
    lyricsWindow = null;
    lyricsVisible = false;
  });
}

function toggleLyricsWindow() {
  if (lyricsVisible) {
    hideLyricsWindow();
  } else {
    showLyricsWindow();
  }
}

function sendLyricsPinState() {
  if (lyricsWindow && !lyricsWindow.isDestroyed()) {
    lyricsWindow.webContents.send('lyrics-pin-state', lyricsPinned);
  }
}

function registerLyricsIpc() {
  ipcMain.on('lyrics-close', hideLyricsWindow);

  ipcMain.handle('lyrics:get-pin-state', () => lyricsPinned);

  ipcMain.handle('lyrics:toggle-pin', () => {
    lyricsPinned = !lyricsPinned;
    lyricsWindow?.setAlwaysOnTop(lyricsPinned);
    sendLyricsPinState();
    return lyricsPinned;
  });

  ipcMain.handle('lyrics:get-settings', () => loadLyricsSettings());

  ipcMain.handle('lyrics:save-settings', (_event, settings) => saveLyricsSettings(settings));

  ipcMain.handle('lyrics:get-font-list', () => loadLyricsFontList());

  ipcMain.handle('lyrics:set-settings-open', async (_event, open, panelHeight) => {
    if (!lyricsWindow || lyricsWindow.isDestroyed()) return;

    const bounds = lyricsWindow.getBounds();
    const extra = Math.max(80, Math.round(panelHeight) || 168);

    if (open) {
      if (lyricsSettingsOpen) return;
      lyricsBaseHeight = bounds.height;
      lyricsSettingsOpen = true;
      await animateLyricsWindowBounds({
        x: bounds.x,
        y: bounds.y - extra,
        width: bounds.width,
        height: bounds.height + extra,
      });
      return;
    }

    if (!lyricsSettingsOpen || lyricsBaseHeight === null) return;
    const currentExtra = bounds.height - lyricsBaseHeight;
    await animateLyricsWindowBounds({
      x: bounds.x,
      y: bounds.y + currentExtra,
      width: bounds.width,
      height: lyricsBaseHeight,
    });
    lyricsSettingsOpen = false;
    lyricsBaseHeight = null;
  });
}

function registerShortcutsIpc() {
  ipcMain.handle('shortcuts:get-config', () => loadShortcutsConfig());

  ipcMain.handle('shortcuts:save-and-apply', async (_event, config) => {
    return applyShortcutsConfig({
      playPause: config.playPause || '',
      next: config.next || '',
      prev: config.prev || '',
    });
  });

  ipcMain.handle('shortcuts:install-system-ctl', async () => {
    return runPrivilegedScript('install-system-shortcuts.sh', [__dirname]);
  });

  ipcMain.handle('shortcuts:uninstall-system-ctl', async () => {
    return runPrivilegedScript('uninstall-system-shortcuts.sh');
  });

  ipcMain.handle('shortcuts:system-ctl-status', () => ({
    installed: systemCtlInstalled(),
  }));
}

function buildMenu() {
  const template = [
    {
      label: '文件',
      submenu: [
        {
          label: '刷新',
          accelerator: 'CmdOrCtrl+R',
          click: () => mainWindow?.webContents.reload(),
        },
        { type: 'separator' },
        {
          label: '退出',
          accelerator: 'CmdOrCtrl+Q',
          click: quitApp,
        },
      ],
    },
    {
      label: '播放',
      submenu: [
        {
          label: '播放 / 暂停',
          accelerator: 'Space',
          click: togglePlayback,
        },
        {
          label: '上一首',
          accelerator: 'CmdOrCtrl+Left',
          click: () => skipTrack('prev'),
        },
        {
          label: '下一首',
          accelerator: 'CmdOrCtrl+Right',
          click: () => skipTrack('next'),
        },
        { type: 'separator' },
        {
          label: '快捷键设置…',
          click: openShortcutsWindow,
        },
      ],
    },
    {
      label: '视图',
      submenu: [
        {
          label: '后退',
          accelerator: 'Alt+Left',
          click: () => mainWindow?.webContents.goBack(),
        },
        {
          label: '前进',
          accelerator: 'Alt+Right',
          click: () => mainWindow?.webContents.goForward(),
        },
        { type: 'separator' },
        {
          label: '开发者工具',
          accelerator: 'F12',
          click: () => mainWindow?.webContents.toggleDevTools(),
        },
        {
          label: '实际大小',
          accelerator: 'CmdOrCtrl+0',
          click: () => mainWindow?.webContents.setZoomLevel(0),
        },
        {
          label: '放大',
          accelerator: 'CmdOrCtrl+Plus',
          click: () => {
            const level = mainWindow?.webContents.getZoomLevel() ?? 0;
            mainWindow?.webContents.setZoomLevel(level + 0.5);
          },
        },
        {
          label: '缩小',
          accelerator: 'CmdOrCtrl+-',
          click: () => {
            const level = mainWindow?.webContents.getZoomLevel() ?? 0;
            mainWindow?.webContents.setZoomLevel(level - 0.5);
          },
        },
        { type: 'separator' },
        {
          label: '歌词悬浮窗',
          type: 'checkbox',
          checked: lyricsVisible,
          click: toggleLyricsWindow,
        },
        { type: 'separator' },
        {
          label: '全屏',
          accelerator: 'F11',
          click: () => {
            if (mainWindow) {
              mainWindow.setFullScreen(!mainWindow.isFullScreen());
            }
          },
        },
      ],
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '在浏览器中打开',
          click: () => shell.openExternal(HOME_URL),
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  updateTrayMenu();
}

function buildTrayContextMenu() {
  return Menu.buildFromTemplate([
    {
      label: '显示窗口',
      click: () => {
        mainWindow?.show();
        mainWindow?.focus();
      },
    },
    { type: 'separator' },
    {
      label: '歌词悬浮窗',
      type: 'checkbox',
      checked: lyricsVisible,
      click: toggleLyricsWindow,
    },
    { type: 'separator' },
    {
      label: '播放 / 暂停',
      click: togglePlayback,
    },
    {
      label: '上一首',
      click: () => skipTrack('prev'),
    },
    {
      label: '下一首',
      click: () => skipTrack('next'),
    },
    { type: 'separator' },
    {
      label: '退出',
      click: quitApp,
    },
  ]);
}

function updateTrayMenu() {
  if (tray) {
    tray.setContextMenu(buildTrayContextMenu());
  }
}

function createTray() {
  const icon = createTrayIcon();
  tray = new Tray(icon.isEmpty() ? nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  ) : icon);

  tray.setToolTip('网易云音乐');
  tray.setContextMenu(buildTrayContextMenu());
  tray.on('click', () => {
    if (!mainWindow) return;
    if (mainWindow.isVisible()) {
      mainWindow.focus();
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

function registerGlobalShortcuts() {
  globalShortcut.register('MediaPlayPause', togglePlayback);
  globalShortcut.register('MediaNextTrack', () => skipTrack('next'));
  globalShortcut.register('MediaPreviousTrack', () => skipTrack('prev'));
}

function createWindow() {
  const state = loadWindowState();

  mainWindow = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    minWidth: 900,
    minHeight: 600,
    show: false,
    autoHideMenuBar: false,
    title: '网易云音乐',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      partition: PARTITION,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      spellcheck: false,
    },
  });

  if (state.isMaximized) {
    mainWindow.maximize();
  }

  mainWindow.webContents.setUserAgent(USER_AGENT);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      saveWindowState();
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.on('resize', saveWindowState);
  mainWindow.on('move', saveWindowState);

  mainWindow.webContents.on('did-finish-load', () => {
    injectPlaybackHelper();
    setTimeout(injectPlaybackHelper, 1500);
    setTimeout(injectPlaybackHelper, 4000);
  });

  mainWindow.webContents.on('frame-created', (_event, details) => {
    details.frame.executeJavaScript(PLAYBACK_HELPER_SCRIPT).catch(() => {});
  });

  mainWindow.loadURL(HOME_URL);

  buildMenu();
  createTray();
}

const startupControlCommand = parseControlArg(process.argv);
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const command = parseControlArg(argv);
    if (command) {
      handleControlCommand(command);
      return;
    }
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    if (process.platform === 'linux') {
      app.setName('netease-cloud-music');
    }
    ensureScriptPermissions();
    writeAppPathConf();
    registerShortcutsIpc();
    registerLyricsIpc();
    createWindow();
    registerGlobalShortcuts();

    if (startupControlCommand) {
      setTimeout(() => handleControlCommand(startupControlCommand), 2500);
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      } else {
        mainWindow?.show();
        mainWindow?.focus();
      }
    });
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    stopLyricsPolling();
  });

  app.on('window-all-closed', () => {
    if (!isQuitting) return;
    app.quit();
  });
}
